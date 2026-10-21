/**
 * Background worker framework for delayed and retryable work.
 *
 * Jobs run outside request handlers with a defined payload format, a retry
 * budget and a dead-letter store, so a task that keeps failing preserves enough
 * context to debug instead of being silently dropped.
 *
 * The queue is deliberately in-memory and dependency-free. Work in this app is
 * initiated client-side, so `drainDueJobs()` is called when a path wants its
 * due work executed; a job is never run twice for the same payload, and
 * reprocessing a job by id is idempotent (a finished job is left untouched).
 *
 * A job's status is not a free-form string: every move goes through the
 * `worker_job` lifecycle table in `core/lifecycle/records.ts`. The framework
 * therefore cannot re-queue a settled job, and a job view rendered anywhere in
 * the UI reads its state from the same table the worker uses.
 */

import {
  createIdempotencyStore,
  type IdempotencyErrorCode,
  type IdempotencyRecord,
  type IdempotencyStore
} from "@/core/idempotency/idempotency";
import { applyTransition, type LifecycleErrorCode } from "@/core/lifecycle/lifecycle";
import { workerJobMachine } from "@/core/lifecycle/records";
import {
  createMemoryQuotaStorage,
  createQuotaStore,
  type QuotaErrorCode,
  type QuotaStore
} from "@/core/quota/quota";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";

/** The states the `worker_job` lifecycle declares, in table order. */
export const JOB_STATUSES = ["queued", "running", "retrying", "succeeded", "dead_lettered"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Codes a rejected job transition can produce. */
export type JobTransitionCode = LifecycleErrorCode;

export interface JobPayload {
  readonly id: string;
  /** Stable, dot-separated operation the handler registered under. */
  readonly operation: string;
  readonly params: Record<string, unknown>;
  /**
   * When set, enqueueing another job with the same key is a no-op for as long
   * as the original job is still queued — the idempotent reprocess.
   */
  readonly dedupeKey?: string;
  readonly maxAttempts: number;
  attempts: number;
  status: JobStatus;
  readonly enqueuedAt: string;
  /** When `status` is `retrying`, the earliest time the job may run again. */
  nextAttemptAt?: string;
  /** Serializable failure context — code plus message, never secrets. */
  lastError?: { code: string; message: string };
  readonly correlationId: string;
}

export interface JobInput {
  operation: string;
  params?: Record<string, unknown>;
  dedupeKey?: string;
  maxAttempts?: number;
  correlationId?: string;
  /** When set, the first run is scheduled this many ms after enqueueing. */
  delayMs?: number;
  /**
   * Idempotency key for the enqueue itself. Use `submit()` rather than
   * `enqueue()` when a retry must not create a second job.
   */
  idempotencyKey?: string;
  /**
   * Who the `worker.enqueue` quota is charged to on `submit()`. Defaults to
   * `system:worker`, a single allowance shared by every unattributed caller.
   */
  principal?: string;
}

export interface SubmitResult {
  readonly job: JobPayload;
  /** True when the key replayed a recorded outcome instead of enqueueing. */
  readonly replayed: boolean;
  readonly record: IdempotencyRecord<{ jobId: string }>;
}

export interface WorkerContext {
  correlationId: string;
  attempt: number;
  /**
   * Aborted when the framework is cancelled or shut down (#142).
   *
   * A handler that does long work should observe this and stop: the framework
   * will not mark an abandoned attempt `succeeded`, and a stopped attempt is
   * retried rather than lost. `signal.throwIfAborted()` is the one-line way to
   * bail at the next checkpoint.
   */
  signal: AbortSignal;
}

export type JobHandler = (
  params: Record<string, unknown>,
  context: WorkerContext
) => void | Promise<void>;

/** Raised by the framework's own abort path, and safe to rethrow from a handler. */
export class WorkerCancelledError extends Error {
  constructor(message = "Worker cancelled") {
    super(message);
    this.name = "WorkerCancelledError";
  }
}

/**
 * Whether a thrown value is one of the cancellation shapes this framework (or a
 * caller reusing the same pattern) produces.
 *
 * Note that the framework itself decides cancellation by its own signal, not by
 * this predicate: a handler that throws an `AbortError` from an unrelated
 * timeout has not been cancelled by a shutdown and must still be reported as a
 * failure. This is exported for handlers that catch our abort and rethrow, and
 * for tests.
 */
export function isCancellation(error: unknown): boolean {
  if (error instanceof WorkerCancelledError) return true;
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  // `AbortController#abort(reason)` and `signal.throwIfAborted()` both surface
  // as a DOMException named "AbortError".
  return name === "AbortError" || name === "TimeoutError";
}

export type ShutdownPhase = "idle" | "cancelling" | "stopped";

/** A job as it stood when shutdown was requested. */
export interface PendingJobReport {
  id: string;
  operation: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
}

export interface ShutdownOptions {
  /** Recorded in the report and in telemetry. Defaults to "shutdown". */
  reason?: string;
}

export interface ShutdownReport {
  readonly reason: string;
  readonly phase: ShutdownPhase;
  /**
   * Queued and retrying jobs. They were never started, so nothing was abandoned
   * and the next process can pick them up unchanged.
   */
  readonly pending: readonly PendingJobReport[];
  /**
   * Jobs whose handler was in flight when the abort landed. Their side effect
   * may be partial, which is why they are reported separately and moved to
   * `retrying` rather than settled.
   */
  readonly interrupted: readonly PendingJobReport[];
  /** Jobs that had already settled before the abort. Untouched. */
  readonly settled: number;
}

/** How long `shutdown()` waits for in-flight handlers before giving up. */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

export interface RetryPolicy {
  /** Base delay in ms; the nth retry waits `retryDelayMs * 2^(n - 1)`. */
  retryDelayMs: number;
  /** Total attempts including the first, after which a job is dead-lettered. */
  maxAttempts: number;
  /** How long a recorded enqueue outcome stays replayable. */
  idempotencyTtlMs: number;
}

export interface RunSummary {
  ran: number;
  succeeded: number;
  failed: number;
  retried: number;
  deadLettered: number;
  /**
   * Attempts abandoned because the framework was cancelled or shut down. Counted
   * separately from `failed` because they are neither successes nor faults: the
   * handler stopped early and the attempt is owed another run.
   */
  cancelled: number;
  /** Jobs still running when the summary was produced (async handlers). */
  inFlight: number;
}

const EMPTY_SUMMARY = (): RunSummary => ({
  ran: 0,
  succeeded: 0,
  failed: 0,
  retried: 0,
  deadLettered: 0,
  cancelled: 0,
  inFlight: 0
});

const DEFAULT_POLICY: RetryPolicy = {
  retryDelayMs: 250,
  maxAttempts: 3,
  idempotencyTtlMs: 24 * 60 * 60 * 1_000
};

export interface WorkerFramework {
  register(operation: string, handler: JobHandler, policy?: Partial<RetryPolicy>): void;
  enqueue(input: JobInput): JobPayload;
  /**
   * The high-risk write path: enqueues under an idempotency key so a retried
   * submission replays the original job instead of creating a duplicate.
   *
   * When the framework was created with `gates`, the matching gate is checked
   * before idempotency and quota. A full gate returns `backpressure_full`
   * immediately without spending quota or recording an idempotency claim.
   */
  submit(input: JobInput): Result<SubmitResult, IdempotencyErrorCode | QuotaErrorCode | "backpressure_full">;
  /** The quota store `submit()` charges. */
  quota(): QuotaStore;
  /** The idempotency records this framework has persisted. */
  idempotency(): IdempotencyStore;
  /** Executes every due job once and returns the lifecycle summary. */
  drainDueJobs(now?: number): RunSummary;
  /**
   * Like `drainDueJobs`, but waits for async handlers to settle, so the summary
   * is final rather than provisional (#142).
   */
  drain(now?: number): Promise<RunSummary>;
  /**
   * Cancel in-flight work and stop starting new work, then report what each job
   * was doing when the abort landed (#142).
   *
   * The contract per state:
   *   queued / retrying — never started, left exactly as they are and reported
   *     as `pending`. Nothing was abandoned, so the next process re-runs them.
   *   running           — the handler had started. Its side effect may be
   *     partial, so the attempt is moved to `retrying` (or `dead_lettered` if
   *     the budget is spent) and reported as `interrupted`. It is never marked
   *     `succeeded`: an abandoned attempt that claims completion is exactly the
   *     failure this exists to prevent.
   *   succeeded / dead_lettered — settled before the abort, untouched.
   *
   * Waits up to `timeoutMs` for in-flight handlers; one that ignores its signal
   * is left running and reported as interrupted.
   */
  shutdown(options?: ShutdownOptions & { timeoutMs?: number }): Promise<ShutdownReport>;
  /** Abort without waiting — the signal flips immediately, drain is not awaited. */
  cancel(reason?: string): void;
  /** Current phase: `idle`, `cancelling` while draining, then `stopped`. */
  phase(): ShutdownPhase;
  /** The signal every handler's context carries. */
  signal(): AbortSignal;
  /** Jobs started but not yet settled. */
  inFlight(): number;
  /** Idempotent reprocess of a single job by id. */
  processJob(id: string): RunSummary;
  /**
   * Resets a `retrying` job to a fresh queued state. A settled job
   * (`succeeded` / `dead_lettered`) is refused with `terminal_state` — the same
   * code the lifecycle table returns — instead of silently running again.
   */
  retryJob(id: string): Result<JobPayload, JobTransitionCode>;
  deadLetter(id: string): Result<JobPayload, JobTransitionCode>;
  /** Asks the lifecycle table whether `event` is legal for a job in `status`. */
  canTransition(status: string, event: string): Result<true, JobTransitionCode>;
  inspect(status?: JobStatus): JobPayload[];
  getById(id: string): JobPayload | undefined;
  /** Test seam: clears the queue and all registrations. */
  reset(): void;
}

/** Exponential backoff: `delay * 2^(attempt - 1)`, capped to avoid overflow. */
export function retryBackoff(baseDelayMs: number, attempt: number): number {
  const factor = 2 ** Math.min(attempt - 1, 30);
  return baseDelayMs * factor;
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "unknown";
}

function findingDedupe(jobs: Map<string, JobPayload>, key: string): JobPayload | undefined {
  for (const job of jobs.values()) {
    if (job.dedupeKey === key && (job.status === "queued" || job.status === "retrying")) {
      return job;
    }
  }
  return undefined;
}

export interface WorkerFrameworkOptions {
  /** Quota store charged by `submit()`. Defaults to an isolated in-memory one. */
  quota?: QuotaStore;
  /**
   * Bounded-queue backpressure gates for expensive background operations.
   *
   * When an `enqueue` (or `submit`) call arrives, each gate is checked in order
   * against the job's `operation`. The first gate whose label is a prefix of the
   * operation handles the call; if the gate is full it returns
   * `backpressure_full` and the job is never enqueued.
   *
   * Gates are optional and purely additive: a framework with no gates behaves
   * exactly as before. Existing callers that never set this option are unaffected.
   *
   * Usage:
   * ```ts
   * const analyticsGate = createBoundedEnqueueGate(framework, {
   *   label: "analytics",
   *   maxConcurrent: 4,
   *   overflowPolicy: "drop_oldest"
   * });
   * const framework = createWorkerFramework({}, { gates: [analyticsGate] });
   * ```
   *
   * Operational notes:
   * - Gates are evaluated before the idempotency and quota checks in `submit()`,
   *   so a rejected job never spends quota.
   * - A gate refusal returns `backpressure_full` from both `enqueue` and
   *   `submit`, distinguishable from a quota or idempotency failure.
   * - Removing a gate from the options array on the next framework instance
   *   restores unbounded behaviour with no state migration required.
   */
  gates?: import("@/core/workers/backpressure").BoundedEnqueueGate[];
}

export function createWorkerFramework(
  policy: Partial<RetryPolicy> = {},
  options: WorkerFrameworkOptions = {}
): WorkerFramework {
  const mergedPolicy: RetryPolicy = { ...DEFAULT_POLICY, ...policy };
  const registrations = new Map<string, { handler: JobHandler; retryDelayMs: number; maxAttempts: number }>();
  const jobs = new Map<string, JobPayload>();
  /**
   * Cancellation state (#142). One controller covers the whole framework, so a
   * single `cancel()` reaches every handler that is in flight, and every job
   * started afterwards sees an already-aborted signal.
   */
  let controller = new AbortController();
  let shutdownPhase: ShutdownPhase = "idle";
  let shutdownReason: string | null = null;
  /** Handlers started and not yet settled. */
  const inFlightSet = new Set<Promise<void>>();
  const idempotencyStore = createIdempotencyStore({ ttlMs: mergedPolicy.idempotencyTtlMs });
  const quotaStore = options.quota ?? createQuotaStore({ storage: createMemoryQuotaStorage() });

  /**
   * Returns the first configured gate whose label prefix matches `operation`,
   * or `undefined` when no gate covers the operation.
   *
   * Gate lookup is O(g) where g is the number of gates (typically 1–3).
   * It is intentionally a separate helper rather than inlined in `enqueue` so
   * the gate path stays readable and testable without reading the full enqueue
   * body.
   */
  function findGate(operation: string) {
    if (!options.gates || options.gates.length === 0) return undefined;
    return options.gates.find((gate) => operation.startsWith(gate.label()));
  }

  /**
   * The only place a job's status changes. Anything the `worker_job` table does
   * not allow is refused, so the queue cannot reach a state no consumer expects.
   */
  function move(
    job: JobPayload,
    event: string,
    reason: string,
    /** Set by the manual entry points: an operator asked, not the worker. */
    audited = false
  ): Result<JobStatus, JobTransitionCode> {
    const outcome = applyTransition(
      workerJobMachine,
      { id: job.id, state: job.status },
      event,
      { actor: "worker", reason, correlationId: job.correlationId, audited }
    );
    if (!outcome.ok) return outcome;
    job.status = outcome.value.to as JobStatus;
    return ok(job.status);
  }

  function isDue(job: JobPayload, now: number): boolean {
    if (job.status !== "queued" && job.status !== "retrying") return false;
    if (job.nextAttemptAt === undefined) return true;
    return Date.parse(job.nextAttemptAt) <= now;
  }

  /**
   * Run one job to a settled or retryable state.
   *
   * Returns a promise when the handler is async, so callers can wait for a final
   * outcome. The handler is *awaited* on purpose (#142): it used to be invoked
   * and discarded, so an async handler was marked `succeeded` before it had done
   * anything and its rejection escaped as an unhandled rejection.
   */
  function runJob(job: JobPayload): void | Promise<void> {
    job.attempts += 1;
    const registration = registrations.get(job.operation);

    if (!registration) {
      job.lastError = {
        code: "unregistered",
        message: `No handler registered for ${job.operation}`
      };
      move(job, "dead_letter", "unregistered_handler");
      emitTelemetry({
        op: "worker.exhausted",
        actorType: "worker",
        result: "failure",
        correlationId: job.correlationId,
        errorCode: "unregistered"
      });
      return;
    }

    move(job, "start", "drained");

    const settle = (error?: unknown): void => {
      // Cancellation wins over both outcomes, and it is decided *only* by our own
      // signal. A handler that threw because the abort reached it has not failed,
      // and one that returned after the abort has not succeeded: its side effect
      // is unknown, so neither `succeed` nor the failure path may claim
      // otherwise.
      //
      // Keying off the signal rather than the error's class matters: a handler
      // with its own timeout throws a cancellation-shaped error for an unrelated
      // reason, and that is a failure this framework should report, not a
      // shutdown it did not initiate.
      if (controller.signal.aborted) {
        const cancelledError =
          error === undefined
            ? new WorkerCancelledError(
                `Cancelled during ${job.operation}: ${shutdownReason ?? "shutdown"}`
              )
            : (error as Error);
        job.lastError = {
          code: "cancelled",
          message: cancelledError instanceof Error ? cancelledError.message : "cancelled"
        };
        if (job.attempts >= job.maxAttempts) {
          move(job, "exhaust", "cancelled_attempts_exhausted");
        } else {
          move(job, "fail", "cancelled");
        }
        emitTelemetry({
          op: "worker.cancelled",
          actorType: "worker",
          result: "failure",
          correlationId: job.correlationId,
          errorCode: "cancelled",
          payload: {
            operation: job.operation,
            attempt: job.attempts,
            reason: shutdownReason ?? "cancel"
          }
        });
        return;
      }

      if (error === undefined) {
        move(job, "succeed", "handler_returned");
        job.lastError = undefined;
        emitTelemetry({
          op: "worker.run",
          actorType: "worker",
          result: "success",
          correlationId: job.correlationId,
          payload: { operation: job.operation, attempt: job.attempts }
        });
        return;
      }

      handleFailure(job, registration, error);
    };

    const context: WorkerContext = {
      correlationId: job.correlationId,
      attempt: job.attempts,
      signal: controller.signal
    };

    try {
      const result = registration.handler(job.params, context);
      if (result && typeof (result as Promise<void>).then === "function") {
        const promise = (result as Promise<void>).then(
          () => settle(),
          (error: unknown) => settle(error)
        );
        inFlightSet.add(promise);
        void promise.finally(() => inFlightSet.delete(promise));
        return promise;
      }
      settle();
    } catch (error) {
      settle(error);
    }
  }

  /** The failure path, shared by the sync and async routes. */
  function handleFailure(
    job: JobPayload,
    registration: { retryDelayMs: number },
    error: unknown
  ): void {
    const code = errorCodeOf(error);
    job.lastError = {
      code,
      message: error instanceof Error ? error.message : "unknown failure"
    };

    // The job's own budget wins; the registration only supplies the default.
    if (job.attempts >= job.maxAttempts) {
      move(job, "exhaust", "attempts_exhausted");
      emitTelemetry({
        op: "worker.exhausted",
        actorType: "worker",
        result: "failure",
        correlationId: job.correlationId,
        errorCode: code,
        payload: { operation: job.operation, attempts: job.attempts }
      });
    } else {
      move(job, "fail", "handler_threw");
      job.nextAttemptAt = new Date(
        Date.now() + retryBackoff(registration.retryDelayMs, job.attempts)
      ).toISOString();
      emitTelemetry({
        op: "worker.retry",
        actorType: "worker",
        result: "failure",
        correlationId: job.correlationId,
        errorCode: code,
        payload: { operation: job.operation, attempt: job.attempts }
      });
    }
  }

  function bumpSummary(summary: RunSummary, job: JobPayload): void {
    // A cancelled attempt ends in `retrying` like any other non-terminal state,
    // so it is counted from `lastError.code` rather than from the status: it is
    // not a fault, and reporting it as one is what made cancellation look like a
    // broken worker.
    if (job.lastError?.code === "cancelled") summary.cancelled += 1;
    else if (job.status === "succeeded") summary.succeeded += 1;
    else if (job.status === "retrying") summary.retried += 1;
    else if (job.status === "dead_lettered") summary.deadLettered += 1;
    else summary.failed += 1;
  }

  /** Snapshot of one job for the shutdown report. */
  function reportJob(job: JobPayload): PendingJobReport {
    return {
      id: job.id,
      operation: job.operation,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts
    };
  }

  // Named so `submit()` can reach the public enqueue without re-entering the
  // object literal while it is being built.
  const framework: WorkerFramework = {
    register(operation, handler, custom = {}): void {
      if (registrations.has(operation)) {
        throw new Error(`[workers] handler already registered for ${operation}`);
      }
      registrations.set(operation, {
        handler,
        retryDelayMs: custom.retryDelayMs ?? mergedPolicy.retryDelayMs,
        maxAttempts: custom.maxAttempts ?? mergedPolicy.maxAttempts
      });
    },

    enqueue(input: JobInput): JobPayload {
      if (input.dedupeKey) {
        const existing = findingDedupe(jobs, input.dedupeKey);
        if (existing) return existing;
      }

      const job: JobPayload = {
        id: newCorrelationId(),
        operation: input.operation,
        params: input.params ?? {},
        dedupeKey: input.dedupeKey,
        maxAttempts: input.maxAttempts ?? mergedPolicy.maxAttempts,
        attempts: 0,
        // The initial state comes from the lifecycle table, not from a literal
        // repeated here.
        status: workerJobMachine.initial() as JobStatus,
        enqueuedAt: new Date().toISOString(),
        nextAttemptAt:
          input.delayMs && input.delayMs > 0
            ? new Date(Date.now() + input.delayMs).toISOString()
            : undefined,
        correlationId: input.correlationId ?? newCorrelationId()
      };
      jobs.set(job.id, job);
      return job;
    },

    submit(input: JobInput): Result<SubmitResult, IdempotencyErrorCode | QuotaErrorCode | "backpressure_full"> {
      // ── Backpressure gate check ────────────────────────────────────────────
      // When the framework has a gate covering this operation, we check capacity
      // before creating an idempotency claim or spending quota.
      //
      // Design note: we call `gate.stats()` + live count rather than
      // `gate.enqueue()` here. The gate was designed as an external facade that
      // calls `framework.enqueue()` itself; calling it from inside `submit()`
      // would create a double-enqueue. Instead, `submit` reads the gate's
      // current live count and refuses early when the gate is full. The gate's
      // own `enqueue()` (used by callers who bypass `submit`) is the other path
      // and handles `drop_oldest` eviction. `submit` always uses reject semantics
      // because idempotency keys require deterministic outcomes.
      //
      // Replays are exempt: if we already have a completed record for this key
      // the job was already enqueued; it either succeeded or is still live, and
      // the gate's live count already includes it.
      const gate = findGate(input.operation);
      if (gate) {
        const { live, maxConcurrent } = gate.stats();
        if (live >= maxConcurrent) {
          return err("backpressure_full");
        }
      }
      const begun = idempotencyStore.begin({
        key: input.idempotencyKey,
        operation: "worker.enqueue",
        request: {
          operation: input.operation,
          params: input.params ?? {},
          dedupeKey: input.dedupeKey ?? null,
          maxAttempts: input.maxAttempts ?? mergedPolicy.maxAttempts,
          delayMs: input.delayMs ?? null
        },
        correlationId: input.correlationId
      });
      if (!begun.ok) return begun;

      if (begun.value.replay) {
        const recorded = begun.value.record as IdempotencyRecord<{ jobId: string }>;
        const jobId = recorded.response?.jobId;
        const job = jobId ? jobs.get(jobId) : undefined;
        if (!job) {
          // The recorded outcome outlived the in-memory job: the caller still
          // gets a consistent answer rather than a second enqueue.
          return err("idempotency_not_found");
        }
        return ok({ job, replayed: true, record: recorded });
      }

      // A replay above is free; only a submission that creates a job is charged.
      const charged = quotaStore.consume({
        operation: "worker.enqueue",
        principal: input.principal ?? "system:worker",
        actorType: "worker",
        correlationId: input.correlationId
      });
      if (!charged.ok) {
        // Released so the same key can succeed once the window resets.
        idempotencyStore.abandon(input.idempotencyKey!);
        return charged;
      }

      const job = framework.enqueue(input);
      const completed = idempotencyStore.complete(input.idempotencyKey!, { jobId: job.id });
      if (!completed.ok) {
        idempotencyStore.abandon(input.idempotencyKey!);
        return completed;
      }
      return ok({ job, replayed: false, record: completed.value });
    },

    quota(): QuotaStore {
      return quotaStore;
    },

    idempotency(): IdempotencyStore {
      return idempotencyStore;
    },

    drainDueJobs(now = Date.now()): RunSummary {
      const summary = EMPTY_SUMMARY();
      // Once cancelling, no *new* work starts (#142). Work already in flight
      // still settles; only the queue is frozen.
      if (shutdownPhase !== "idle") {
        summary.inFlight = inFlightSet.size;
        return summary;
      }

      const due = [...jobs.values()].filter((job) => isDue(job, now));

      for (const job of due) {
        summary.ran += 1;
        const settled = runJob(job);
        // An async handler has not finished yet, so its outcome is counted when
        // it settles; the provisional summary reports it as in flight.
        if (settled) continue;
        bumpSummary(summary, job);
      }

      summary.inFlight = inFlightSet.size;
      return summary;
    },

    async drain(now = Date.now()): Promise<RunSummary> {
      const summary = EMPTY_SUMMARY();
      if (shutdownPhase !== "idle") {
        summary.inFlight = inFlightSet.size;
        return summary;
      }

      const due = [...jobs.values()].filter((job) => isDue(job, now));

      // Jobs an earlier synchronous drain left running. This call waits for them
      // below, so they belong in the summary it returns — otherwise a caller who
      // drained and then awaited would see the work complete and a summary that
      // never mentions it.
      const inherited = [...jobs.values()].filter((job) => job.status === "running");
      const counted = new Set<string>();

      for (const job of due) {
        summary.ran += 1;
        counted.add(job.id);
        const settled = runJob(job);
        if (!settled) bumpSummary(summary, job);
      }

      // Await every handler still running, not only the ones this call started.
      await Promise.all([...inFlightSet]);

      for (const job of due) bumpSummary(summary, job);
      for (const job of inherited) {
        if (counted.has(job.id)) continue;
        counted.add(job.id);
        summary.ran += 1;
        bumpSummary(summary, job);
      }
      summary.inFlight = inFlightSet.size;
      return summary;
    },

    cancel(reason = "cancel"): void {
      if (shutdownPhase !== "idle") return;
      shutdownReason = reason;
      shutdownPhase = "cancelling";
      controller.abort(new WorkerCancelledError(`Worker cancelled: ${reason}`));
    },

    async shutdown(options = {}): Promise<ShutdownReport> {
      const reason = options.reason ?? "shutdown";
      const timeoutMs = options.timeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;

      // What each job was doing *when the abort landed*, captured before the
      // drain. Classifying afterwards would miss a handler that ignores its
      // signal and never settles: it is still `running`, its side effect is
      // unknown, and it is exactly the job the caller most needs told about.
      const atAbort = new Map<string, JobStatus>(
        [...jobs.values()].map((job) => [job.id, job.status])
      );

      framework.cancel(reason);

      // Give in-flight handlers a chance to observe the signal and stop. One
      // that ignores it is left running; the report below says so, because a
      // job whose side effect is still in progress is precisely what a caller
      // needs to know about at shutdown.
      if (inFlightSet.size > 0) {
        await Promise.race([
          Promise.allSettled([...inFlightSet]),
          new Promise((resolve) => setTimeout(resolve, timeoutMs))
        ]);
      }

      shutdownPhase = "stopped";

      const pending: PendingJobReport[] = [];
      const interrupted: PendingJobReport[] = [];
      let settledCount = 0;

      for (const job of jobs.values()) {
        const statusAtAbort = atAbort.get(job.id) ?? job.status;
        if (statusAtAbort === "succeeded" || statusAtAbort === "dead_lettered") {
          settledCount += 1;
        } else if (statusAtAbort === "running" || job.lastError?.code === "cancelled") {
          // Was running, or settled as cancelled while we waited. Either way the
          // attempt was abandoned and is owed another run.
          interrupted.push(reportJob(job));
        } else {
          // Queued or retrying: never started, so nothing was abandoned.
          pending.push(reportJob(job));
        }
      }

      emitTelemetry({
        op: "worker.shutdown",
        actorType: "worker",
        result: "success",
        payload: {
          reason,
          pending: pending.length,
          interrupted: interrupted.length,
          settled: settledCount
        }
      });

      return {
        reason,
        phase: shutdownPhase,
        pending,
        interrupted,
        settled: settledCount
      };
    },

    phase(): ShutdownPhase {
      return shutdownPhase;
    },

    signal(): AbortSignal {
      return controller.signal;
    },

    inFlight(): number {
      return inFlightSet.size;
    },

    processJob(id: string): RunSummary {
      const summary = EMPTY_SUMMARY();
      const job = jobs.get(id);
      if (!job) return summary;
      // Idempotent reprocessing: a terminal job has no legal `start` event, so
      // it is left untouched instead of running its handler a second time.
      if (workerJobMachine.isTerminal(job.status)) return summary;
      // Reprocessing is starting new work, so it is refused while cancelling
      // for the same reason a drain is.
      if (shutdownPhase !== "idle") {
        summary.inFlight = inFlightSet.size;
        return summary;
      }

      summary.ran += 1;
      const settled = runJob(job);
      if (!settled) bumpSummary(summary, job);
      summary.inFlight = inFlightSet.size;
      return summary;
    },

    retryJob(id: string): Result<JobPayload, JobTransitionCode> {
      const job = jobs.get(id);
      if (!job) return err("unknown_state");
      const moved = move(job, "retry", "manual_retry", true);
      if (!moved.ok) return moved;
      job.nextAttemptAt = undefined;
      job.attempts = 0;
      return ok(job);
    },

    deadLetter(id: string): Result<JobPayload, JobTransitionCode> {
      const job = jobs.get(id);
      if (!job) return err("unknown_state");
      const moved = move(job, "dead_letter", "manual_dead_letter", true);
      if (!moved.ok) return moved;
      return ok(job);
    },

    canTransition(status: string, event: string): Result<true, JobTransitionCode> {
      return workerJobMachine.canTransition(status, event);
    },

    inspect(status?: JobStatus): JobPayload[] {
      const all = [...jobs.values()];
      return status ? all.filter((job) => job.status === status) : all;
    },

    getById(id: string): JobPayload | undefined {
      return jobs.get(id);
    },

    reset(): void {
      jobs.clear();
      registrations.clear();
      inFlightSet.clear();
      // A reset framework accepts work again: a fresh controller replaces the
      // aborted one, and the phase returns to idle, so the next drain runs.
      shutdownPhase = "idle";
      shutdownReason = null;
      controller = new AbortController();
      idempotencyStore.reset();
      // A shared quota store belongs to the caller; only an owned one is cleared.
      if (!options.quota) quotaStore.reset();
      // Reset gate counters so a test that calls reset() starts with a clean
      // gate state. Gates are owned by the caller when passed via options.gates,
      // but their counters are scoped to this framework's job map, so resetting
      // the map without resetting the counters would leave stale stats.
      if (options.gates) {
        for (const gate of options.gates) gate.reset();
      }
    }
  };

  return framework;
}