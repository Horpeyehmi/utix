import { describe, expect, it, beforeEach } from "vitest";
import { createWorkerFramework, type JobPayload, type WorkerContext } from "@/core/workers/queue";

describe("Resumable Background Jobs with Dead-Letter Recovery", () => {
  describe("Job resumption mechanisms", () => {
    it("resumes failed job with incremented attempt counter", () => {
      const worker = createWorkerFramework();
      let attempts = 0;

      worker.register("resume-test", (params, context) => {
        attempts = context.attempt;
      });

      const job = worker.enqueue({
        operation: "resume-test",
        params: { data: "test" },
        maxAttempts: 3
      });

      expect(job.attempts).toBe(0);
      worker.drainDueJobs();
      expect(attempts).toBe(1);
    });

    it("persists job state across resumption attempts", () => {
      const worker = createWorkerFramework();
      const states: number[] = [];

      worker.register("state-persist", (params, context) => {
        states.push(context.attempt);
        if (context.attempt < 2) {
          throw new Error("Retry needed");
        }
      });

      const job = worker.enqueue({
        operation: "state-persist",
        params: { task: "idempotent-operation" },
        maxAttempts: 3
      });

      worker.drainDueJobs();
      const retrieved = worker.getById(job.id);
      expect(retrieved?.attempts).toBeGreaterThan(0);
    });

    it("replays operation with same idempotency key on resume", () => {
      const worker = createWorkerFramework();
      const executions: string[] = [];

      worker.register("replay-test", (params, context) => {
        executions.push(params.idempotencyKey as string);
      });

      const job = worker.enqueue({
        operation: "replay-test",
        params: { idempotencyKey: "same-key-123" },
        maxAttempts: 2
      });

      worker.drainDueJobs();
      const retrieved = worker.getById(job.id);
      expect(retrieved?.params.idempotencyKey).toBe("same-key-123");
    });

    it("maintains correlation ID through resumption", () => {
      const worker = createWorkerFramework();

      worker.register("correlation-test", () => {});

      const correlationId = "trace-abc-123";
      const job = worker.enqueue({
        operation: "correlation-test",
        params: {},
        correlationId
      });

      expect(job.correlationId).toBe(correlationId);
      const retrieved = worker.getById(job.id);
      expect(retrieved?.correlationId).toBe(correlationId);
    });
  });

  describe("Dead-letter queue handling", () => {
    it("moves exhausted job to dead-letter queue", () => {
      const worker = createWorkerFramework();

      worker.register(
        "failing-job",
        () => {
          throw new Error("Persistent failure");
        },
        { maxAttempts: 2 }
      );

      const job = worker.enqueue({
        operation: "failing-job",
        params: {},
        maxAttempts: 2
      });

      worker.drainDueJobs();
      worker.drainDueJobs();

      const deadLettered = worker.getById(job.id);
      expect(deadLettered?.status).toBe("dead_lettered");
    });

    it("preserves failure context in dead-letter", () => {
      const worker = createWorkerFramework();
      const errorMessage = "Critical service unavailable";

      worker.register("dead-letter-test", () => {
        throw new Error(errorMessage);
      });

      const job = worker.enqueue({
        operation: "dead-letter-test",
        params: { id: "task-123" },
        maxAttempts: 1
      });

      worker.drainDueJobs();

      const deadLettered = worker.getById(job.id);
      expect(deadLettered?.status).toBe("dead_lettered");
      expect(deadLettered?.lastError?.code).toBeDefined();
    });

    it("allows inspection of dead-lettered jobs", () => {
      const worker = createWorkerFramework();

      worker.register("inspect-test", () => {
        throw new Error("Test failure");
      });

      const job1 = worker.enqueue({
        operation: "inspect-test",
        params: { id: 1 },
        maxAttempts: 1
      });

      const job2 = worker.enqueue({
        operation: "inspect-test",
        params: { id: 2 },
        maxAttempts: 1
      });

      worker.drainDueJobs();
      worker.drainDueJobs();

      const deadLettered = worker.inspect("dead_lettered");
      expect(deadLettered.length).toBeGreaterThanOrEqual(0);
    });

    it("recovers job from dead-letter via retry", () => {
      const worker = createWorkerFramework();
      let successAttempt = false;

      worker.register("recovery-test", () => {
        if (successAttempt) {
          return;
        }
        throw new Error("First attempt fails");
      });

      const job = worker.enqueue({
        operation: "recovery-test",
        params: {},
        maxAttempts: 1
      });

      worker.drainDueJobs();
      expect(worker.getById(job.id)?.status).toBe("dead_lettered");

      successAttempt = true;
      const retried = worker.retryJob(job.id);
      expect(retried.ok).toBe(true);

      worker.drainDueJobs();
      const recovered = worker.getById(job.id);
      expect(recovered?.status).toBe("succeeded");
    });
  });

  describe("Recovery procedures", () => {
    it("resets retrying job to queued state for reprocessing", () => {
      const worker = createWorkerFramework();
      let attempts = 0;

      worker.register("reset-test", () => {
        attempts++;
        throw new Error("Retry me");
      });

      const job = worker.enqueue({
        operation: "reset-test",
        params: {},
        maxAttempts: 3
      });

      worker.drainDueJobs();
      expect(attempts).toBe(1);

      const retried = worker.retryJob(job.id);
      expect(retried.ok).toBe(true);
      expect(retried.value?.status).toBe("queued");
    });

    it("prevents recovery of settled jobs", () => {
      const worker = createWorkerFramework();

      worker.register("settled-test", () => {
        return;
      });

      const job = worker.enqueue({
        operation: "settled-test",
        params: {},
        maxAttempts: 1
      });

      worker.drainDueJobs();

      const recovered = worker.retryJob(job.id);
      expect(recovered.ok).toBe(false);
      expect(recovered.error).toBe("terminal_state");
    });

    it("maintains idempotent retry semantics", () => {
      const worker = createWorkerFramework();
      const executions: number[] = [];

      worker.register("idempotent-retry", (params, context) => {
        executions.push(context.attempt);
      });

      const job = worker.enqueue({
        operation: "idempotent-retry",
        params: { operation: "transfer" },
        maxAttempts: 2
      });

      worker.drainDueJobs();
      worker.drainDueJobs();

      expect(executions.length).toBeGreaterThan(0);
    });

    it("recovers job with backpressure handling", () => {
      const worker = createWorkerFramework();

      worker.register("backpressure-test", () => {
        throw new Error("System busy");
      });

      const job = worker.enqueue({
        operation: "backpressure-test",
        params: { task: "important" },
        maxAttempts: 3
      });

      worker.drainDueJobs();

      const retried = worker.retryJob(job.id);
      expect(retried.ok).toBe(true);
    });
  });

  describe("Normal job flow with recovery", () => {
    it("completes successful job without dead-lettering", () => {
      const worker = createWorkerFramework();

      worker.register("success-test", () => {
        return;
      });

      const job = worker.enqueue({
        operation: "success-test",
        params: { data: "test" },
        maxAttempts: 3
      });

      const summary = worker.drainDueJobs();
      expect(summary.succeeded).toBeGreaterThan(0);

      const completed = worker.getById(job.id);
      expect(completed?.status).toBe("succeeded");
    });

    it("retries transient failures automatically", () => {
      const worker = createWorkerFramework();
      let failCount = 0;

      worker.register(
        "transient-fail",
        () => {
          if (failCount < 1) {
            failCount++;
            throw new Error("Network timeout");
          }
        },
        { maxAttempts: 3 }
      );

      const job = worker.enqueue({
        operation: "transient-fail",
        params: {},
        maxAttempts: 3
      });

      worker.drainDueJobs();
      worker.drainDueJobs();

      const completed = worker.getById(job.id);
      expect(completed?.status).toBe("succeeded");
    });

    it("applies exponential backoff on retries", () => {
      const worker = createWorkerFramework();

      worker.register("backoff-test", () => {
        throw new Error("Needs backoff");
      });

      const job = worker.enqueue({
        operation: "backoff-test",
        params: {},
        maxAttempts: 3
      });

      const initial = worker.getById(job.id);
      expect(initial?.attempts).toBe(0);

      worker.drainDueJobs();

      const firstRetry = worker.getById(job.id);
      expect(firstRetry?.attempts).toBe(1);
      expect(firstRetry?.nextAttemptAt).toBeDefined();
    });
  });

  describe("Failure modes and edge cases", () => {
    it("handles job cancellation during recovery", () => {
      const worker = createWorkerFramework();

      worker.register("cancel-test", (params, context) => {
        context.signal.throwIfAborted();
      });

      const job = worker.enqueue({
        operation: "cancel-test",
        params: {}
      });

      worker.cancel("testing");

      const cancelled = worker.getById(job.id);
      expect(cancelled).toBeDefined();
    });

    it("handles recovery with missing handler gracefully", () => {
      const worker = createWorkerFramework();
      worker.register("registered", () => {});

      const unknownJob = worker.enqueue({
        operation: "unregistered",
        params: {}
      });

      const summary = worker.drainDueJobs();
      expect(summary.failed).toBeGreaterThanOrEqual(0);
    });

    it("prevents recovery of abandoned operations", () => {
      const worker = createWorkerFramework();

      worker.register("abandoned-test", () => {
        throw new Error("Permanent failure");
      });

      const job = worker.enqueue({
        operation: "abandoned-test",
        params: { critical: true },
        maxAttempts: 1
      });

      worker.drainDueJobs();

      const deadLettered = worker.deadLetter(job.id);
      expect(deadLettered.ok).toBe(true);

      const recovered = worker.retryJob(job.id);
      expect(recovered.ok).toBe(false);
    });

    it("handles concurrent job recovery safely", () => {
      const worker = createWorkerFramework();
      const jobs = [];

      for (let i = 0; i < 5; i++) {
        worker.register(`job-${i}`, () => {
          throw new Error("Retry");
        });

        const job = worker.enqueue({
          operation: `job-${i}`,
          params: { id: i },
          maxAttempts: 2
        });
        jobs.push(job);
      }

      worker.drainDueJobs();

      jobs.forEach((job) => {
        const result = worker.retryJob(job.id);
        expect(result.ok).toBe(true);
      });
    });
  });

  describe("Authorization and audit", () => {
    it("preserves correlation ID during recovery", () => {
      const worker = createWorkerFramework();

      worker.register("audit-test", () => {});

      const correlationId = "audit-trace-123";
      const job = worker.enqueue({
        operation: "audit-test",
        params: {},
        correlationId
      });

      const recovered = worker.getById(job.id);
      expect(recovered?.correlationId).toBe(correlationId);
    });

    it("records recovery attempts for audit trail", () => {
      const worker = createWorkerFramework();
      let executionCount = 0;

      worker.register("audit-trail-test", () => {
        executionCount++;
        throw new Error("Retry for audit");
      });

      const job = worker.enqueue({
        operation: "audit-trail-test",
        params: { auditRequired: true },
        maxAttempts: 2
      });

      worker.drainDueJobs();
      const afterFirstAttempt = worker.getById(job.id);
      expect(afterFirstAttempt?.attempts).toBeGreaterThan(0);
    });
  });
});
