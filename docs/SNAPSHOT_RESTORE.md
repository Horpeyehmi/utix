# Snapshot Capture and Restore Verification

Utix stores all state in the browser (localStorage + in-memory). When a session
restores from a snapshot — after re-hydration, a forced rollback or a data
migration — the values that come back may be mutually inconsistent: primary
records may not match what the derived indexes point to, schema versions may
have moved, or a ledger sequence may have regressed.

`core/archive/snapshot.ts` provides a two-phase restore pipeline that verifies
every declared invariant, rebuilds derived indexes deterministically, and **fails
loudly** on any mismatch — so an inconsistent state is never silently applied.

## Design principles

- **Verify before commit.** `verifyAndRestore` is a pipeline, not a write
  function. It does not touch any storage directly; the caller supplies
  `onRestore` as the commit step, and it is only called when all checks pass.
- **Loud failure, never silent.** On any hard violation, `verifyAndRestore`
  throws `SnapshotMismatchError` *and* emits `snapshot.restore_failed`
  telemetry *and* writes a `projection.replayed denied` audit event — three
  independent signals so the failure surfaces even if one channel is missed.
- **All violations at once.** Every failing invariant and every failing record is
  collected before the throw, so operators see the complete picture, not just the
  first failure.
- **Index drift is reported, not fatal.** Indexes are derived views; drift is
  expected during migrations. `SnapshotRestoreResult.indexMismatches` lists
  every differing key. The caller decides whether drift is acceptable.
- **`preflight` for pre-flight checks.** `preflight()` wraps `verifyAndRestore`
  with `dryRun: true` and returns a `Result` instead of throwing — use it to
  validate before committing.

## Quick start

```ts
import {
  captureSnapshot,
  verifyAndRestore,
  preflight,
  SnapshotMismatchError,
  type SnapshotInvariant
} from "@/core/archive/snapshot";

// 1. Declare invariants for your record type.
const invariants: SnapshotInvariant<TicketRecord>[] = [
  {
    name: "ticket.has_owner",
    description: "Every ticket must have a non-empty ownerId.",
    check: (r) => typeof r.ownerId === "string" && r.ownerId.length > 0
  },
  {
    name: "ticket.positive_amount",
    check: (r) => r.amount > 0
  }
];

// 2. Capture the current state.
const snap = captureSnapshot(records, {
  schemaVersion: 2,
  ledgerSequence: currentLedger,
  indexBuilder: (rs) => Object.fromEntries(rs.map((r) => [`ticket:${r.id}`, r.ownerId])),
  hashFn: (rs) => rs.map((r) => r.id).sort().join(","),
  metadata: { capturedBy: "operator", reason: "pre_migration" }
});

// 3. Validate and restore.
try {
  const result = verifyAndRestore(snap, {
    invariants,
    expectedSchemaVersion: 2,
    minLedgerSequence: 500,
    indexBuilder: buildIndex,
    hashFn: hashRecords,
    onRestore: (records, index) => {
      store.tickets = [...records];
      store.index = { ...index };
    }
  });
  console.log(`Restored ${result.primaryRecordCount} records`);
  if (result.indexMismatches.length > 0) {
    console.warn("Index drift detected:", result.indexMismatches);
  }
} catch (e) {
  if (e instanceof SnapshotMismatchError) {
    console.error("Restore failed:", e.violations);
    // onRestore was NOT called — previous state is intact.
  }
}
```

## Rollback pattern

Always capture a pre-restore snapshot before applying an incoming one. If the
restore fails, re-apply the pre-restore snapshot.

```ts
// Step 1: capture the current state as the rollback point.
const preRestoreSnap = captureSnapshot(store.tickets, {
  schemaVersion: CURRENT_SCHEMA,
  ledgerSequence: store.ledgerSequence,
  indexBuilder: buildIndex
});

// Step 2: preflight the incoming snapshot (no commit yet).
const check = preflight(incomingSnap, { invariants, expectedSchemaVersion: 2 });
if (!check.ok) {
  // Violations in check.detail — do not proceed.
  return { error: check.code, violations: check.detail };
}

// Step 3: commit.
try {
  verifyAndRestore(incomingSnap, { invariants, indexBuilder: buildIndex, onRestore: commit });
} catch (e) {
  if (e instanceof SnapshotMismatchError) {
    // Step 4: rollback — re-apply the pre-restore snapshot.
    verifyAndRestore(preRestoreSnap, { invariants, indexBuilder: buildIndex, onRestore: commit });
  }
}
```

## Verification phases

`verifyAndRestore` runs four phases in order. It collects all violations before
throwing; only hard violations (phases 1–2) throw. Phase 3 is index diff (never
throws). Phase 4 is the commit (only if `dryRun` is false and phase 1–2 pass).

| Phase | Check | Throws? |
|---|---|---|
| 1a | Schema version — snapshot matches `expectedSchemaVersion` | Yes |
| 1b | Ledger sequence — snapshot ≥ `minLedgerSequence` | Yes |
| 1c | Content hash — re-hash matches `snapshot.contentHash` | Yes |
| 2 | Per-record invariants — every record passes every `SnapshotInvariant` | Yes |
| 3 | Index rebuild diff — rebuilt index vs. snapshot's stored index | No (reported) |
| 4 | Commit — `onRestore(records, rebuiltIndex)` called | N/A |

## Operational edge cases

| Scenario | Behaviour | Recovery |
|---|---|---|
| Invariant violation | `SnapshotMismatchError` thrown; `onRestore` never called; prior state untouched | Inspect `error.violations`, fix snapshot data, re-run. Use `preflight()` to check first. |
| Schema version regression (snapshot older than runtime) | `schema_version_mismatch` violation — blocked | Run migration to upgrade snapshot, re-capture, then restore. Or set `allowSchemaMigration: true` to accept with a warning. |
| Schema version upgrade (snapshot newer than runtime) | `schema_version_mismatch` violation — blocked | Upgrade the application before restoring this snapshot. |
| Ledger sequence regression | `ledger_sequence_regression` violation — blocked | Restore from a newer snapshot, or lower `minLedgerSequence` if the regression is intentional. |
| Content hash mismatch | `content_hash_mismatch` violation — blocked | Discard the snapshot and re-capture from a trusted source. |
| Index drift after rebuild | `indexMismatches` reported in the result — **not thrown** | Review each mismatch; drift is expected during migrations. If strict fidelity is required, check `result.indexMismatches.length === 0` before accepting the result. |
| Throwing invariant check | Recorded as `invariant_failed` violation, not re-thrown | Fix the invariant's `check` function or the record that caused the throw. |
| `dryRun: true` | All phases run, `onRestore` never called | Use `preflight()` as the standard pre-flight API — it wraps `dryRun` and returns a `Result`. |

## Invariant authoring guidelines

- Keep `check` functions **pure and fast** — they run synchronously for every
  record in the snapshot.
- Give every invariant a **stable `name`** — it appears in violation reports,
  telemetry and the audit trail. Use `domain.rule` convention, e.g.
  `ticket.has_owner`.
- Write a **`description`** — it replaces the generic violation detail when the
  check returns `false`. Operators read it in the audit trail.
- A throwing `check` is recorded as a violation. Do not throw intentionally;
  return `false` instead.
- Invariants are declared per caller, not per module, so `snapshot.ts` never
  needs to know your domain model.

## Content hash authoring guidelines

A hash function must be **deterministic**: the same records in the same order
must always produce the same string. Safe approaches:

```ts
// Sort-stable hash over record ids:
const hashFn = (rs: T[]) => rs.map((r) => r.id).sort().join(",");

// Full JSON (deterministic only if key order is stable):
const hashFn = (rs: T[]) => JSON.stringify(rs.map((r) => ({ id: r.id, v: r.version })));
```

Do **not** use `Date.now()`, `Math.random()` or any non-deterministic value.

## Audit trail

Every restore attempt writes a `projection.replayed` audit event:

- **`outcome: "allowed"`** — restore passed all checks and `onRestore` ran.
- **`outcome: "denied"`** — one or more violations were found; restore was
  blocked. `errorCode: "snapshot_invariant_violation"`.

Query via:

```ts
import { getAuditTrail } from "@/core/audit/audit";
const events = getAuditTrail()
  .all()
  .filter((e) => e.action === "projection.replayed" && e.target.kind === "snapshot");
```

## Telemetry events

| Op | When |
|---|---|
| `snapshot.restore_succeeded` | All checks passed, `onRestore` called (or `dryRun: true`) |
| `snapshot.restore_failed` | Any hard violation — emitted **before** the throw |

Both events carry `snapshotId`, `schemaVersion`, `ledgerSequence` and
`recordCount` in their payload.

## Tests

```bash
npx vitest run core/archive/__tests__/snapshot.test.ts --reporter=verbose
```

Test file: `core/archive/__tests__/snapshot.test.ts`

Covered paths: captureSnapshot (stamp, hash, index), all invariant violation
types (failed, throwing check), schema downgrade/upgrade, ledger regression,
hash mismatch, index drift (reported not thrown), dryRun, preflight Result
return, rollback sequence, telemetry emission, audit trail (success + failure).
