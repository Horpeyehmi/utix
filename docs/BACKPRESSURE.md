# Bounded Queue Backpressure

Expensive background operations — analytics aggregations, Soroban simulations,
index rebuilds, export generations — must not be enqueued without limit. A
runaway retry loop, a stuck handler or a burst of UI interactions can exhaust
memory and quota for everyone sharing the queue.

`core/workers/backpressure.ts` adds a **gate** in front of `WorkerFramework`
that enforces a hard concurrency ceiling per operation label.

## Design principles

- **Capacity is hard.** A gate counts live jobs (queued + retrying + running)
  for its prefix. Once that count reaches `maxConcurrent`, new enqueues are
  refused. The ceiling is an integer, not a guideline.
- **Overflow policy is explicit.** `reject` (default) refuses the caller
  immediately and returns `backpressure_full`. `drop_oldest` evicts the oldest
  queued or retrying job in the slot (dead-letters it, never cancels in-flight
  work) and admits the new one — useful for "latest state wins" work like
  analytics snapshots.
- **Self-healing.** The live count is recomputed from the framework's job map on
  every check, so a job that is externally dead-lettered, cancelled or retried
  heals the gate without any sync step.
- **Authorization is required to change limits.** Only a `maintainer` actor
  (`admin:recovery` permission) may call `adjustCapacity`. A `viewer` receives
  `backpressure_unauthorized`.
- **Every decision is telemetered.** `backpressure.enqueue`,
  `backpressure.overflow` and `backpressure.capacity_changed` appear in the
  structured log.

## Quick start

```ts
import { createWorkerFramework } from "@/core/workers/queue";
import { createBoundedEnqueueGate } from "@/core/workers/backpressure";

const framework = createWorkerFramework();

// Create the gate first (it needs the framework reference for live-count reads).
const analyticsGate = createBoundedEnqueueGate(framework, {
  label: "analytics",       // meters any operation starting with "analytics"
  maxConcurrent: 4,
  overflowPolicy: "drop_oldest"
});

framework.register("analytics.aggregate", async (params) => { /* … */ });

// Enqueue through the gate (the gate calls framework.enqueue internally).
const result = analyticsGate.enqueue({ operation: "analytics.aggregate", params });
if (!result.ok) {
  // result.code === "backpressure_full"
  await analyticsGate.waitForCapacity();
  // retry…
}
```

### Using `gates` in `createWorkerFramework`

Alternatively, pass gates directly to the framework factory. `submit()` will then
check gate capacity before spending idempotency/quota:

```ts
const framework = createWorkerFramework({}, { gates: [analyticsGate] });

const result = framework.submit({
  operation: "analytics.aggregate",
  idempotencyKey: requestId,
  params
});

if (!result.ok && result.code === "backpressure_full") {
  // Quota was NOT spent. Retry after waitForCapacity().
  await analyticsGate.waitForCapacity();
}
```

Key difference: `submit()` always uses **reject** semantics regardless of the
gate's `overflowPolicy`. Idempotency keys require deterministic outcomes;
dropping-and-replacing a job whose key is already recorded would produce an
inconsistent replay. Use the gate's `enqueue()` directly when you want
`drop_oldest`.

## Adjusting capacity at runtime

```ts
const adjusted = gate.adjustCapacity(
  { role: "maintainer" },
  8,               // new ceiling (must be ≤ maxCapacityCeiling)
  "peak_sale_load" // stable reason code
);
if (adjusted.ok) {
  console.log(`capacity: ${adjusted.value.previous} → ${adjusted.value.next}`);
}
```

Lowering below the current live count is allowed — the gate refuses new work
until the backlog drains to the new limit. No jobs are forcibly killed.

## Waiting for a slot

```ts
while (true) {
  const r = gate.enqueue({ operation: "analytics.aggregate", params });
  if (r.ok) break;
  await gate.waitForCapacity(); // resolves when a slot opens or ceiling is raised
}
```

`waitForCapacity()` resolves immediately when capacity is already available. It
never rejects.

## Operational edge cases

| Scenario | Behaviour | Recovery |
|---|---|---|
| Burst > `maxConcurrent` | `reject` → `backpressure_full` or `drop_oldest` eviction | Wait on `waitForCapacity()`, or raise ceiling via `adjustCapacity()` |
| Stuck running job holds a slot | Gate's live count includes it until it leaves `running` | Force dead-letter: `framework.deadLetter(id)` — the gate heals on next check |
| `drop_oldest` evicts a retrying job | Evicted job is dead-lettered; its payload and error context are intact | Inspect with `framework.inspect("dead_lettered")`; requeue if still needed |
| Viewer calls `adjustCapacity` | `backpressure_unauthorized` | Only a `maintainer` actor may adjust |
| Ceiling attempt above `maxCapacityCeiling` | `backpressure_invalid_capacity` | Use a value ≤ `maxCapacityCeiling` (default: `maxConcurrent × 10`) |
| Framework shutdown during a full gate | In-flight jobs settle; `waitForCapacity()` resolves as slots open | No action — gate heals automatically |
| Gate removed from `options.gates` | Unbounded behaviour restored on the next framework instance | No migration — gate state is entirely in-memory and non-durable |

## Rollback

Gates are non-durable and stateless between sessions. To roll back:

1. Remove the gate from `options.gates` when calling `createWorkerFramework`.
2. Replace calls to `gate.enqueue()` with `framework.enqueue()`.

No schema change, no storage migration.

## Stats

```ts
const { live, maxConcurrent, admitted, rejected, evicted } = gate.stats();
```

- `live` — current occupancy (recomputed from the framework map on every call).
- `admitted` — total enqueues admitted since last reset.
- `rejected` — total enqueues refused due to full capacity.
- `evicted` — total jobs evicted by `drop_oldest`.

## Telemetry events

| Op | When |
|---|---|
| `backpressure.enqueue` | Every call, admitted or bypassed (non-labeled ops) |
| `backpressure.overflow` | Capacity exceeded — includes `policy`, `evictedJobId` on `drop_oldest` |
| `backpressure.capacity_changed` | `adjustCapacity` succeeds or is denied |

## Tests

```bash
npm run test:workers
# or specifically:
npx vitest run core/workers/__tests__/backpressure.test.ts --reporter=verbose
```

Test file: `core/workers/__tests__/backpressure.test.ts`

Covered paths: normal admit, reject overflow, drop_oldest eviction, all-running
fallback, retry slot retention, slot release on settle, maintainer/viewer auth,
waitForCapacity, self-healing after external dead-letter, constructor validation,
stats and reset.
