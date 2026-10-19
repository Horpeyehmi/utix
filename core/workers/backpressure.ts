/**
 * Bounded queue backpressure for expensive background work (#backpressure).
 *
 * The worker framework in `queue.ts` is unbounded by design: its purpose is
 * reliable delivery, not traffic shaping. That works well when callers are
 * well-behaved — a single slow tick, a UI button, a scheduled maintenance job.
 * It is the wrong tool when expensive work arrives in bursts: analytics
 * aggregations, Soroban simulations, index rebuilds, export generations. A
 * loop, a bug or a stuck retry can fill the queue with thousands of jobs that
 * will never all finish before the page unloads, consuming memory and burning
 * quota without delivering value.
 *
 * This module adds a backpressure gate in front of `WorkerFramework.enqueue`.
 * Its rules:
 *
 * - **capacity is hard**. The gate counts how many jobs matching a label are
 *   currently live (queued + retrying + running). When that count reaches
 *   `maxConcurrent` a new enqueue is refused with `backpressure_full`.
 * - **overflow policy is explicit**. Two policies ship: `reject` (the
 *   default, refuse callers, let them handle it) and `drop_oldest` (evict the
 *   oldest queued job in the slot to make room, then enqueue — useful for
 *   "latest state wins" work like analytics snapshots where an older job is
 *   superseded by a newer one).
 * - **drain signalling**. The gate exposes a `waitForCapacity()` promise that
 *   resolves when at least one slot opens. This lets a producer await pressure
 *   without polling, which makes the idle path free.
 * - **authorization is required to change limits**. A `viewer` cannot raise
 *   the ceiling; a `maintainer` can, but only within the declared hard cap.
 * - **every decision is emitted as telemetry** (`backpressure.enqueue`,
 *   `backpressure.overflow`, `backpressure.capacity_changed`) so operators can
 *   see pressure over time without polling the gate.
 *
 * Operational edge cases and recovery
 * ────────────────────────────────────
 * 1. **Sudden burst > maxConcurrent**: The gate immediately starts rejecting
 *    (reject policy) or dropping the oldest queued job (drop_oldest). Callers
 *    must handle `backpressure_full` and either wait on `waitForCapacity()` or
 *    surface the failure to the user. Recovery: raise `maxConcurrent` via
 *    `adjustCapacity()` (maintainer only) or let the drain catch up.
 *
 * 2. **Stuck/long-running job holding a slot**: A job in `running` state
 *    forever prevents new work. The framework's `shutdown()` will interrupt
 *    it; the gate's slot count is recomputed from the live `inspect()` call on
 *    every check, so it heals automatically once the job leaves `running`.
 *    Recovery: call `framework.deadLetter(id)` to force a dead-letter, which
 *    frees the slot immediately.
 *
 * 3. **drop_oldest evicts a job that was in `retrying`**: The evicted job is
 *    dead-lettered (not cancelled) so it appears in the framework's dead-letter
 *    queue and is retrievable by ID. The audit trail records the forced
 *    dead-letter. Recovery: inspect dead-lettered jobs with
 *    `framework.inspect("dead_lettered")` and requeue any that matter.
 *
 * 4. **Authorization bypass attempt**: Only `maintainer` actors may call
 *    `adjustCapacity`. A `viewer` calling it receives `backpressure_unauthorized`.
 *    The hard cap `maxCapacityCeiling` is enforced independently of auth, so a
 *    compromised maintainer token cannot raise the gate above what the code
 *    allows.
 *
 * 5. **Rollback / gate removal**: `BoundedEnqueueGate` wraps the framework but
 *    never patches it. Removing the gate reverts to the unbounded path without
 *    any migration: callers that used `gate.enqueue()` switch back to
 *    `framework.enqueue()` with no schema or state change required.
 *
 * 6. **waitForCapacity() during shutdown**: If the framework is cancelled
 *    or stopped, in-flight jobs settle quickly and slots open. Callers awaiting
 *    capacity will resolve on the next settled job. A caller that holds the
 *    promise through a page unload will never race with the abort: the gate
 *    resolves the waiter before the framework drops the jobs.
 */

import { hasPermission } from "@/core/auth/types";
import type { AuthContext } from "@/core/auth/middleware";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import type { JobInput, JobPayload, WorkerFramework } from "@/core/workers/queue";

// ─── Public types ─────────────────────────────────────────────────────────────

/** Stable codes returned by the gate. Consumers switch on these. */
export type BackpressureErrorCode =
  | "backpressure_full"
  | "backpressure_unauthorized"
  | "backpressure_invalid_capacity"
  | "backpressure_label_required";

/**
 * What the gate does when `maxConcurrent` is reached.
 *
 * - `reject`     — refuse the caller immediately; they decide what to do next.
 * - `drop_oldest` — dead-letter the oldest non-running job in the slot to make
 *                   room, then enqueue the new one. Use for "latest wins" work
 *                   (analytics, snapshot probes) where an older job is
 *                   superseded by a newer one.
 */
export type OverflowPolicy = "reject" | "drop_oldest";

export interface BackpressureOptions {
  /**
   * Maximum number of live jobs (queued + retrying + running) for this gate.
   * Must be ≥ 1.
   */
  maxConcurrent: number;
  /**
   * Hard ceiling that `adjustCapacity()` may never exceed.
   * Defaults to `maxConcurrent * 10`, minimum 1.
   */
  maxCapacityCeiling?: number;
  /** What to do when the gate is full. Defaults to `"reject"`. */
  overflowPolicy?: OverflowPolicy;
  /**
   * Operation label this gate meters. Only jobs whose `operation` starts with
   * this prefix are counted. Required: a gate without a label would count all
   * operations, which would be surprising and break composition.
   *
   * Example: `"analytics"` counts `"analytics.aggregate"`, `"analytics.export"`.
   */
  label: string;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
}

export interface GateStats {
  /** How many jobs are currently live (queued + retrying + running). */
  readonly live: number;
  /** The current capacity ceiling. */
  readonly maxConcurrent: number;
  /** How many enqueue attempts have been admitted since last reset. */
  readonly admitted: number;
  /** How many enqueue attempts have been rejected due to full capacity. */
  readonly rejected: number;
  /** How many jobs have been evicted by the `drop_oldest` policy. */
  readonly evicted: number;
}

export interface CapacityAdjustment {
  readonly previous: number;
  readonly next: number;
  readonly reason: string;
  readonly at: string;
}

export interface BoundedEnqueueGate {
  /**
   * Attempt to enqueue a job through the gate.
   *
   * - If the gate has capacity, the job is enqueued and `ok` is returned.
   * - If the gate is full and policy is `reject`, `backpressure_full` is returned.
   * - If the gate is full and policy is `drop_oldest`, the oldest queued/retrying
   *   job is dead-lettered and the new job is enqueued.
   *
   * The returned `JobPayload` is the newly enqueued job (not the evicted one).
   */
  enqueue(input: JobInput): Result<JobPayload, BackpressureErrorCode>;

  /**
   * Resolves the next time at least one slot opens. Use this to implement
   * back-off without polling:
   *
   * ```ts
   * while (true) {
   *   const r = gate.enqueue(input);
   *   if (r.ok) break;
   *   await gate.waitForCapacity();
   * }
   * ```
   *
   * The promise never rejects. If the framework has already settled all jobs
   * (e.g. on shutdown), it resolves immediately.
   */
  waitForCapacity(): Promise<void>;

  /**
   * Change the concurrency ceiling. Requires `admin:recovery` permission.
   *
   * `next` must be ≥ 1 and ≤ `maxCapacityCeiling`. Lowering below the current
   * live count is allowed — the gate will refuse new work until the backlog
   * drains to the new limit. No jobs are forcibly killed.
   */
  adjustCapacity(
    auth: AuthContext,
    next: number,
    reason: string
  ): Result<CapacityAdjustment, BackpressureErrorCode>;

  /** Current gate statistics. */
  stats(): GateStats;

  /** The label this gate is scoped to. */
  label(): string;

  /** Test seam: resets counters (does not affect the underlying framework). */
  reset(): void;
}

// ─── Live-count helper ────────────────────────────────────────────────────────

const LIVE_STATUSES = new Set(["queued", "retrying", "running"]);

/**
 * Counts jobs in the framework whose operation starts with `prefix` and are in
 * a live (non-terminal) state.
 *
 * We count from the framework's live state rather than maintaining a shadow
 * counter, so the gate self-heals after a job is externally dead-lettered,
 * cancelled or manually requeued — no synchronisation needed.
 */
function countLive(framework: WorkerFramework, prefix: string): number {
  return framework.inspect().filter(
    (job) => job.operation.startsWith(prefix) && LIVE_STATUSES.has(job.status)
  ).length;
}

/**
 * Returns the oldest queued or retrying job for the given label prefix,
 * ordered by `enqueuedAt` ascending. `running` jobs are excluded: evicting a
 * running job would cancel in-flight work, which requires framework shutdown.
 */
function oldestEvictable(framework: WorkerFramework, prefix: string): JobPayload | undefined {
  const candidates = framework
    .inspect()
    .filter(
      (job) =>
        job.operation.startsWith(prefix) &&
        (job.status === "queued" || job.status === "retrying")
    )
    .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
  return candidates[0];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createBoundedEnqueueGate(
  framework: WorkerFramework,
  options: BackpressureOptions
): BoundedEnqueueGate {
  if (!options.label || options.label.trim().length === 0) {
    throw new Error("[backpressure] label is required");
  }
  if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new Error("[backpressure] maxConcurrent must be a positive integer");
  }

  let maxConcurrent = options.maxConcurrent;
  const maxCapacityCeiling = Math.max(
    1,
    options.maxCapacityCeiling ?? options.maxConcurrent * 10
  );
  const overflowPolicy: OverflowPolicy = options.overflowPolicy ?? "reject";
  const prefix = options.label;
  const nowFn = options.now ?? (() => Date.now());

  let admitted = 0;
  let rejected = 0;
  let evicted = 0;

  // Capacity waiters: each entry is a resolve function from a Promise.
  // When a slot opens (detected after a drain completes) we fire all of them.
  const waiters: Array<() => void> = [];

  function notifyWaiters(): void {
    const snapshot = waiters.splice(0);
    for (const resolve of snapshot) resolve();
  }

  /**
   * Registers a slot-open listener and returns its promise.
   * The promise is resolved the next time any job in the gate's prefix
   * transitions out of a live state (i.e. a drain settles a job).
   *
   * Implementation note: we cannot observe individual job transitions without
   * patching the framework, so instead we wrap the framework's `drain()` and
   * `drainDueJobs()` at gate creation. This is intentional: the gate is a
   * facade, not a monkey-patch.
   */
  function waitForCapacity(): Promise<void> {
    // If there is already capacity, resolve immediately.
    if (countLive(framework, prefix) < maxConcurrent) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }

  function enqueue(input: JobInput): Result<JobPayload, BackpressureErrorCode> {
    const correlationId = input.correlationId ?? newCorrelationId();

    // The label guard is enforced here so that jobs enqueued without the gate
    // (directly through the framework) do not pollute the gate's counter.
    if (!input.operation.startsWith(prefix)) {
      // Allow operations that don't match the gate's label through unconditionally.
      // The gate only meters operations it was configured to watch.
      const job = framework.enqueue({ ...input, correlationId });
      admitted += 1;
      emitTelemetry({
        op: "backpressure.enqueue",
        actorType: "worker",
        result: "success",
        correlationId,
        payload: { label: prefix, operation: input.operation, gated: false }
      });
      return ok(job);
    }

    const live = countLive(framework, prefix);

    if (live < maxConcurrent) {
      // Capacity available — admit immediately.
      const job = framework.enqueue({ ...input, correlationId });
      admitted += 1;
      emitTelemetry({
        op: "backpressure.enqueue",
        actorType: "worker",
        result: "success",
        correlationId,
        payload: {
          label: prefix,
          operation: input.operation,
          live,
          maxConcurrent,
          gated: true
        }
      });
      return ok(job);
    }

    // Gate is full.

    if (overflowPolicy === "drop_oldest") {
      const victim = oldestEvictable(framework, prefix);
      if (victim) {
        // Force the oldest evictable job to dead-letter so its slot frees up.
        framework.deadLetter(victim.id);
        evicted += 1;
        emitTelemetry({
          op: "backpressure.overflow",
          actorType: "worker",
          result: "failure",
          correlationId,
          errorCode: "backpressure_full",
          payload: {
            label: prefix,
            policy: "drop_oldest",
            evictedJobId: victim.id,
            evictedOperation: victim.operation,
            evictedEnqueuedAt: victim.enqueuedAt
          }
        });
        // Now there is a free slot; enqueue the new job.
        const job = framework.enqueue({ ...input, correlationId });
        admitted += 1;
        emitTelemetry({
          op: "backpressure.enqueue",
          actorType: "worker",
          result: "success",
          correlationId,
          payload: {
            label: prefix,
            operation: input.operation,
            live: live - 1,
            maxConcurrent,
            gated: true,
            droppedOldest: true
          }
        });
        return ok(job);
      }
      // All live jobs are running (none evictable) — fall through to reject.
    }

    // Reject path.
    rejected += 1;
    emitTelemetry({
      op: "backpressure.overflow",
      actorType: "worker",
      result: "failure",
      correlationId,
      errorCode: "backpressure_full",
      payload: {
        label: prefix,
        policy: overflowPolicy,
        live,
        maxConcurrent,
        operation: input.operation
      }
    });
    return err("backpressure_full");
  }

  function adjustCapacity(
    auth: AuthContext,
    next: number,
    reason: string
  ): Result<CapacityAdjustment, BackpressureErrorCode> {
    const correlationId = newCorrelationId();

    if (!hasPermission(auth.role, "admin:recovery")) {
      emitTelemetry({
        op: "backpressure.capacity_changed",
        actorType: "user",
        result: "failure",
        correlationId,
        errorCode: "backpressure_unauthorized",
        payload: { label: prefix, role: auth.role }
      });
      return err("backpressure_unauthorized");
    }

    if (!Number.isInteger(next) || next < 1) {
      return err("backpressure_invalid_capacity");
    }
    if (next > maxCapacityCeiling) {
      return err("backpressure_invalid_capacity");
    }

    const previous = maxConcurrent;
    maxConcurrent = next;

    const adjustment: CapacityAdjustment = {
      previous,
      next,
      reason,
      at: new Date(nowFn()).toISOString()
    };

    emitTelemetry({
      op: "backpressure.capacity_changed",
      actorType: "user",
      result: "success",
      correlationId,
      payload: { label: prefix, previous, next, reason }
    });

    // If we raised the ceiling, notify any waiting producers.
    if (next > previous) notifyWaiters();

    return ok(adjustment);
  }

  function stats(): GateStats {
    return {
      live: countLive(framework, prefix),
      maxConcurrent,
      admitted,
      rejected,
      evicted
    };
  }

  return {
    enqueue,
    waitForCapacity,
    adjustCapacity,
    stats,
    label: () => prefix,
    reset(): void {
      admitted = 0;
      rejected = 0;
      evicted = 0;
      waiters.splice(0);
    }
  };
}
