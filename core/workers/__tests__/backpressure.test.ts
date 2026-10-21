/**
 * Tests for bounded queue backpressure (core/workers/backpressure.ts).
 *
 * Coverage:
 *   - Normal path: admit jobs up to capacity
 *   - Overflow path: reject when full (reject policy)
 *   - Overflow path: drop oldest and admit (drop_oldest policy)
 *   - Retry path: retrying jobs hold a slot; settled jobs release it
 *   - Authorization path: maintainer may adjust capacity, viewer cannot
 *   - waitForCapacity: resolves once a slot opens
 *   - Label scoping: operations outside the prefix are passed through unmetered
 *   - Hard-cap ceiling: adjustCapacity cannot exceed maxCapacityCeiling
 *   - Self-healing: externally dead-lettered jobs free their slot
 *   - Stats accuracy: admitted / rejected / evicted counters track correctly
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoundedEnqueueGate, type BoundedEnqueueGate } from "@/core/workers/backpressure";
import { createWorkerFramework, type WorkerFramework } from "@/core/workers/queue";
import { setTelemetrySink, createCaptureSink, resetTelemetrySink } from "@/core/telemetry/telemetry";
import type { AuthContext } from "@/core/auth/middleware";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VIEWER: AuthContext = { role: "viewer" };
const MAINTAINER: AuthContext = { role: "maintainer" };

/** A framework with a noop handler registered for `analytics.aggregate`. */
function makeFramework(): WorkerFramework {
  const fw = createWorkerFramework();
  fw.register("analytics.aggregate", vi.fn());
  fw.register("analytics.export", vi.fn());
  fw.register("other.operation", vi.fn());
  return fw;
}

/** Creates a gate with `label: "analytics"` and `maxConcurrent: 2`. */
function makeGate(
  fw: WorkerFramework,
  overrides: Partial<Parameters<typeof createBoundedEnqueueGate>[1]> = {}
): BoundedEnqueueGate {
  return createBoundedEnqueueGate(fw, {
    label: "analytics",
    maxConcurrent: 2,
    ...overrides
  });
}

// ─── Normal path ──────────────────────────────────────────────────────────────

describe("normal path — admit jobs up to capacity", () => {
  let fw: WorkerFramework;
  let gate: BoundedEnqueueGate;

  beforeEach(() => {
    fw = makeFramework();
    gate = makeGate(fw);
  });

  it("admits a job when the gate has capacity", () => {
    const result = gate.enqueue({ operation: "analytics.aggregate" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.operation).toBe("analytics.aggregate");
    expect(result.value.status).toBe("queued");
  });

  it("admits jobs up to maxConcurrent without error", () => {
    const r1 = gate.enqueue({ operation: "analytics.aggregate" });
    const r2 = gate.enqueue({ operation: "analytics.aggregate" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("reports live count in stats correctly", () => {
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" });
    const s = gate.stats();
    expect(s.live).toBe(2);
    expect(s.admitted).toBe(2);
    expect(s.rejected).toBe(0);
  });

  it("exposes the configured label", () => {
    expect(gate.label()).toBe("analytics");
  });

  it("passes operations not matching the prefix through unmetered", () => {
    // Fill up the gate with labeled ops first.
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" });
    // An unrelated operation is still enqueued even though the gate is full.
    const result = gate.enqueue({ operation: "other.operation" });
    expect(result.ok).toBe(true);
    // Live count only counts labeled ops.
    expect(gate.stats().live).toBe(2);
  });
});

// ─── Overflow — reject policy ──────────────────────────────────────────────

describe("overflow path — reject policy", () => {
  let fw: WorkerFramework;
  let gate: BoundedEnqueueGate;

  beforeEach(() => {
    fw = makeFramework();
    gate = makeGate(fw, { overflowPolicy: "reject" });
  });

  it("returns backpressure_full when capacity is reached", () => {
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" });
    const result = gate.enqueue({ operation: "analytics.aggregate" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("backpressure_full");
  });

  it("increments the rejected counter on overflow", () => {
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" }); // rejected
    gate.enqueue({ operation: "analytics.aggregate" }); // rejected
    const s = gate.stats();
    expect(s.admitted).toBe(2);
    expect(s.rejected).toBe(2);
    expect(s.evicted).toBe(0);
  });

  it("emits backpressure.overflow telemetry on reject", () => {
    const sink = createCaptureSink();
    setTelemetrySink(sink);
    try {
      gate.enqueue({ operation: "analytics.aggregate" });
      gate.enqueue({ operation: "analytics.aggregate" });
      gate.enqueue({ operation: "analytics.aggregate" }); // overflow
      const overflowEvents = sink.filter((e) => e.op === "backpressure.overflow");
      expect(overflowEvents).toHaveLength(1);
      expect(overflowEvents[0].errorCode).toBe("backpressure_full");
    } finally {
      resetTelemetrySink();
    }
  });

  it("accepts new jobs once a slot opens after drain", () => {
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" });

    // Drain the framework so both jobs succeed.
    fw.drainDueJobs();

    // Now slots are free.
    const result = gate.enqueue({ operation: "analytics.aggregate" });
    expect(result.ok).toBe(true);
  });
});

// ─── Overflow — drop_oldest policy ───────────────────────────────────────────

describe("overflow path — drop_oldest policy", () => {
  let fw: WorkerFramework;
  let gate: BoundedEnqueueGate;

  beforeEach(() => {
    fw = makeFramework();
    gate = makeGate(fw, { overflowPolicy: "drop_oldest" });
  });

  it("evicts the oldest queued job and admits the new one", () => {
    const first = gate.enqueue({ operation: "analytics.aggregate", params: { seq: 1 } });
    gate.enqueue({ operation: "analytics.aggregate", params: { seq: 2 } });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Third job causes eviction of the oldest (first).
    const third = gate.enqueue({ operation: "analytics.aggregate", params: { seq: 3 } });
    expect(third.ok).toBe(true);

    // The evicted job should be dead-lettered.
    const deadLettered = fw.inspect("dead_lettered");
    expect(deadLettered.map((j) => j.id)).toContain(first.value.id);
  });

  it("increments the evicted counter", () => {
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" }); // evicts first
    const s = gate.stats();
    expect(s.evicted).toBe(1);
    expect(s.admitted).toBe(3);
    expect(s.rejected).toBe(0);
  });

  it("falls back to reject when all live jobs are running (no evictable slot)", async () => {
    // Enqueue two jobs and start them by draining asynchronously (without settling).
    const fw2 = createWorkerFramework();
    let resolve1!: () => void;
    let resolve2!: () => void;
    fw2.register("analytics.aggregate", (_params, ctx) => {
      return new Promise<void>((res) => {
        // Hang until the test resolves it.
        const handle = setInterval(() => {
          if (ctx.signal.aborted) { clearInterval(handle); res(); }
        }, 10);
        resolve1 = resolve2 = () => { clearInterval(handle); res(); };
      });
    });

    const gate2 = createBoundedEnqueueGate(fw2, {
      label: "analytics",
      maxConcurrent: 2,
      overflowPolicy: "drop_oldest"
    });

    gate2.enqueue({ operation: "analytics.aggregate" });
    gate2.enqueue({ operation: "analytics.aggregate" });

    // Start draining — jobs are now running (async, in-flight).
    const drainPromise = fw2.drain();

    // Give the event loop a tick so the handlers actually start.
    await Promise.resolve();

    // Now all live jobs are running — no evictable candidates exist.
    const result = gate2.enqueue({ operation: "analytics.aggregate" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("backpressure_full");

    // Clean up.
    resolve1();
    resolve2();
    await drainPromise;
    fw2.reset();
  });

  it("emits backpressure.overflow with drop_oldest payload on eviction", () => {
    const sink = createCaptureSink();
    setTelemetrySink(sink);
    try {
      gate.enqueue({ operation: "analytics.aggregate" });
      gate.enqueue({ operation: "analytics.aggregate" });
      gate.enqueue({ operation: "analytics.aggregate" }); // triggers eviction
      const overflow = sink.find((e) => e.op === "backpressure.overflow");
      expect(overflow).toBeDefined();
      expect(overflow?.payload?.policy).toBe("drop_oldest");
      expect(overflow?.payload?.evictedJobId).toBeDefined();
    } finally {
      resetTelemetrySink();
    }
  });
});

// ─── Retry path ───────────────────────────────────────────────────────────────

describe("retry path — retrying jobs occupy a slot until settled", () => {
  let fw: WorkerFramework;
  let gate: BoundedEnqueueGate;

  beforeEach(() => {
    fw = makeFramework();
    // Register a handler that fails so jobs enter retrying state.
    fw.register("analytics.retry_test", () => {
      throw new Error("transient failure");
    });
    gate = makeGate(fw, { maxConcurrent: 1 });
  });

  it("a retrying job still occupies its slot", () => {
    const job = gate.enqueue({ operation: "analytics.retry_test", maxAttempts: 3 });
    expect(job.ok).toBe(true);

    // Drain — the job fails and enters retrying.
    fw.drainDueJobs();
    if (job.ok) expect(job.value.status).toBe("retrying");

    // The gate's slot is still occupied.
    const second = gate.enqueue({ operation: "analytics.retry_test" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("backpressure_full");
  });

  it("a dead-lettered job frees its slot", () => {
    const job = gate.enqueue({ operation: "analytics.retry_test", maxAttempts: 1 });
    expect(job.ok).toBe(true);

    // Drain — exhausts the budget and moves to dead_lettered.
    fw.drainDueJobs();
    if (job.ok) expect(job.value.status).toBe("dead_lettered");

    // Slot is now free.
    const next = gate.enqueue({ operation: "analytics.retry_test" });
    expect(next.ok).toBe(true);
  });

  it("a succeeded job frees its slot", () => {
    // Re-register with a succeeding handler.
    fw.reset();
    fw.register("analytics.aggregate", vi.fn());
    const g = makeGate(fw, { maxConcurrent: 1 });

    g.enqueue({ operation: "analytics.aggregate" });
    fw.drainDueJobs(); // succeeds

    // Slot should be free.
    const r = g.enqueue({ operation: "analytics.aggregate" });
    expect(r.ok).toBe(true);
  });
});

// ─── Authorization path ───────────────────────────────────────────────────────

describe("authorization path — adjustCapacity", () => {
  let fw: WorkerFramework;
  let gate: BoundedEnqueueGate;

  beforeEach(() => {
    fw = makeFramework();
    gate = makeGate(fw, { maxConcurrent: 2, maxCapacityCeiling: 10 });
  });

  it("maintainer can raise the capacity ceiling", () => {
    const result = gate.adjustCapacity(MAINTAINER, 5, "peak_load");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previous).toBe(2);
    expect(result.value.next).toBe(5);
    expect(gate.stats().maxConcurrent).toBe(5);
  });

  it("maintainer can lower the capacity ceiling", () => {
    const result = gate.adjustCapacity(MAINTAINER, 1, "throttle");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.next).toBe(1);
  });

  it("viewer is refused with backpressure_unauthorized", () => {
    const result = gate.adjustCapacity(VIEWER, 5, "attempt");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("backpressure_unauthorized");
  });

  it("capacity cannot exceed maxCapacityCeiling", () => {
    const result = gate.adjustCapacity(MAINTAINER, 11, "too_high");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("backpressure_invalid_capacity");
  });

  it("capacity cannot be set below 1", () => {
    const result = gate.adjustCapacity(MAINTAINER, 0, "zero");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("backpressure_invalid_capacity");
  });

  it("raising the ceiling admits previously-blocked jobs", () => {
    // Fill the gate.
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" });
    expect(gate.enqueue({ operation: "analytics.aggregate" }).ok).toBe(false);

    // Raise the ceiling.
    gate.adjustCapacity(MAINTAINER, 3, "raised");

    // Now a third job fits.
    expect(gate.enqueue({ operation: "analytics.aggregate" }).ok).toBe(true);
  });

  it("emits backpressure.capacity_changed telemetry on success", () => {
    const sink = createCaptureSink();
    setTelemetrySink(sink);
    try {
      gate.adjustCapacity(MAINTAINER, 4, "load_event");
      const event = sink.find((e) => e.op === "backpressure.capacity_changed");
      expect(event).toBeDefined();
      expect(event?.result).toBe("success");
      expect(event?.payload?.previous).toBe(2);
      expect(event?.payload?.next).toBe(4);
    } finally {
      resetTelemetrySink();
    }
  });

  it("emits failure telemetry when viewer tries to adjust capacity", () => {
    const sink = createCaptureSink();
    setTelemetrySink(sink);
    try {
      gate.adjustCapacity(VIEWER, 5, "attempt");
      const event = sink.find((e) => e.op === "backpressure.capacity_changed");
      expect(event?.result).toBe("failure");
      expect(event?.errorCode).toBe("backpressure_unauthorized");
    } finally {
      resetTelemetrySink();
    }
  });
});

// ─── waitForCapacity ──────────────────────────────────────────────────────────

describe("waitForCapacity", () => {
  it("resolves immediately when the gate has capacity", async () => {
    const fw = makeFramework();
    const gate = makeGate(fw);
    // Gate is empty — capacity is available.
    await expect(gate.waitForCapacity()).resolves.toBeUndefined();
  });

  it("resolves after the capacity is raised", async () => {
    const fw = makeFramework();
    const gate = makeGate(fw, { maxConcurrent: 1, maxCapacityCeiling: 5 });
    gate.enqueue({ operation: "analytics.aggregate" });

    // Gate is full — grab the promise before raising capacity.
    const waiting = gate.waitForCapacity();

    // Raise capacity — this should notify waiters.
    gate.adjustCapacity(MAINTAINER, 2, "raise");

    await expect(waiting).resolves.toBeUndefined();
  });

  it("resolves immediately after drain frees slots", async () => {
    const fw = createWorkerFramework();
    fw.register("analytics.aggregate", vi.fn());
    const gate = createBoundedEnqueueGate(fw, {
      label: "analytics",
      maxConcurrent: 1
    });
    gate.enqueue({ operation: "analytics.aggregate" });

    // Drain settles the job, freeing the slot.
    fw.drainDueJobs();

    // Gate should now have capacity.
    await expect(gate.waitForCapacity()).resolves.toBeUndefined();
  });
});

// ─── Self-healing ─────────────────────────────────────────────────────────────

describe("self-healing — externally dead-lettered jobs free their slot", () => {
  it("detects when a job is dead-lettered outside the gate", () => {
    const fw = makeFramework();
    const gate = makeGate(fw, { maxConcurrent: 1 });

    const r = gate.enqueue({ operation: "analytics.aggregate" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Gate is full.
    expect(gate.enqueue({ operation: "analytics.aggregate" }).ok).toBe(false);

    // Dead-letter the job directly through the framework (external to the gate).
    fw.deadLetter(r.value.id);

    // Gate recomputes live count — slot is now free.
    expect(gate.stats().live).toBe(0);
    expect(gate.enqueue({ operation: "analytics.aggregate" }).ok).toBe(true);
  });
});

// ─── Constructor validation ────────────────────────────────────────────────────

describe("constructor validation", () => {
  it("throws when label is empty", () => {
    const fw = makeFramework();
    expect(() =>
      createBoundedEnqueueGate(fw, { label: "", maxConcurrent: 1 })
    ).toThrow("[backpressure] label is required");
  });

  it("throws when maxConcurrent is not a positive integer", () => {
    const fw = makeFramework();
    expect(() =>
      createBoundedEnqueueGate(fw, { label: "analytics", maxConcurrent: 0 })
    ).toThrow("[backpressure] maxConcurrent must be a positive integer");
  });

  it("throws when maxConcurrent is a float", () => {
    const fw = makeFramework();
    expect(() =>
      createBoundedEnqueueGate(fw, { label: "analytics", maxConcurrent: 1.5 })
    ).toThrow("[backpressure] maxConcurrent must be a positive integer");
  });
});

// ─── Stats and reset ──────────────────────────────────────────────────────────

describe("stats and reset", () => {
  it("reset clears counters without affecting the underlying framework", () => {
    const fw = makeFramework();
    const gate = makeGate(fw);
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" }); // rejected

    expect(gate.stats().admitted).toBe(2);
    expect(gate.stats().rejected).toBe(1);

    gate.reset();

    expect(gate.stats().admitted).toBe(0);
    expect(gate.stats().rejected).toBe(0);
    // Framework still has the jobs.
    expect(fw.inspect("queued")).toHaveLength(2);
  });

  it("stats.live decreases as jobs settle", () => {
    const fw = createWorkerFramework();
    fw.register("analytics.aggregate", vi.fn());
    const gate = createBoundedEnqueueGate(fw, { label: "analytics", maxConcurrent: 3 });

    gate.enqueue({ operation: "analytics.aggregate" });
    gate.enqueue({ operation: "analytics.aggregate" });
    expect(gate.stats().live).toBe(2);

    fw.drainDueJobs();
    expect(gate.stats().live).toBe(0);
  });
});
