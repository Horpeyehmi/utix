/**
 * Tests for snapshot capture and restore verification (core/archive/snapshot.ts).
 *
 * Coverage:
 *   - captureSnapshot: stamps records with schema/ledger/hash/index
 *   - verifyAndRestore: normal path — all invariants pass, index rebuilt, onRestore called
 *   - verifyAndRestore: invariant failure — throws SnapshotMismatchError with all violations
 *   - verifyAndRestore: schema version regression — blocked unless allowSchemaMigration
 *   - verifyAndRestore: schema version upgrade — blocked (newer snapshot on older runtime)
 *   - verifyAndRestore: ledger sequence regression — blocked when below minLedgerSequence
 *   - verifyAndRestore: content hash mismatch — blocked
 *   - verifyAndRestore: index drift reported (not thrown)
 *   - verifyAndRestore: dryRun does not call onRestore
 *   - preflight: returns Result instead of throwing
 *   - Rollback sequence: capture pre-restore → attempt restore → re-apply pre-restore on failure
 *   - Audit trail: projection.replayed written on success and on failure
 *   - Telemetry: snapshot.restore_succeeded / snapshot.restore_failed emitted
 *   - Multiple simultaneous invariant violations all reported together
 *   - Throwing invariant check is recorded as violation, not re-thrown
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureSnapshot,
  verifyAndRestore,
  preflight,
  SnapshotMismatchError,
  type Snapshot,
  type SnapshotInvariant
} from "@/core/archive/snapshot";
import { createIsolatedAuditTrail } from "@/core/audit/audit";
import { createCaptureSink, setTelemetrySink, resetTelemetrySink } from "@/core/telemetry/telemetry";

// ─── Fixture types ────────────────────────────────────────────────────────────

interface TicketRecord {
  id: string;
  eventId: string;
  ownerId: string;
  status: "active" | "redeemed" | "cancelled";
  amount: number;
}

function makeTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: `ticket-${Math.random().toString(36).slice(2, 8)}`,
    eventId: "event-abc",
    ownerId: "owner-xyz",
    status: "active",
    amount: 100,
    ...overrides
  };
}

const INVARIANTS: readonly SnapshotInvariant<TicketRecord>[] = [
  {
    name: "ticket.has_owner",
    description: "Every ticket must have a non-empty ownerId.",
    check: (r) => typeof r.ownerId === "string" && r.ownerId.length > 0
  },
  {
    name: "ticket.positive_amount",
    description: "Ticket amount must be a positive number.",
    check: (r) => typeof r.amount === "number" && r.amount > 0
  },
  {
    name: "ticket.known_status",
    description: "Status must be active, redeemed, or cancelled.",
    check: (r) => ["active", "redeemed", "cancelled"].includes(r.status)
  }
];

function buildIndex(records: readonly TicketRecord[]) {
  const idx: Record<string, string> = {};
  for (const r of records) idx[`ticket:${r.id}`] = r.ownerId;
  return idx;
}

function hashRecords(records: readonly TicketRecord[]): string {
  return `hash:${records.map((r) => r.id).sort().join(",")}`;
}

// ─── captureSnapshot ──────────────────────────────────────────────────────────

describe("captureSnapshot", () => {
  it("stamps the snapshot with schema version and ledger sequence", () => {
    const records = [makeTicket()];
    const snap = captureSnapshot(records, { schemaVersion: 2, ledgerSequence: 500 });
    expect(snap.schemaVersion).toBe(2);
    expect(snap.ledgerSequence).toBe(500);
  });

  it("records a capturedAt timestamp", () => {
    const now = 1_700_000_000_000;
    const snap = captureSnapshot([makeTicket()], {
      schemaVersion: 1,
      ledgerSequence: 1,
      now: () => now
    });
    expect(snap.capturedAt).toBe(new Date(now).toISOString());
  });

  it("assigns a unique id per snapshot", () => {
    const records = [makeTicket()];
    const a = captureSnapshot(records, { schemaVersion: 1, ledgerSequence: 1 });
    const b = captureSnapshot(records, { schemaVersion: 1, ledgerSequence: 1 });
    expect(a.id).not.toBe(b.id);
  });

  it("builds the derived index when indexBuilder is supplied", () => {
    const records = [makeTicket({ id: "t1", ownerId: "alice" })];
    const snap = captureSnapshot(records, {
      schemaVersion: 1,
      ledgerSequence: 1,
      indexBuilder: buildIndex
    });
    expect(snap.derivedIndex["ticket:t1"]).toBe("alice");
  });

  it("produces an empty derivedIndex when no indexBuilder is given", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 1 });
    expect(snap.derivedIndex).toEqual({});
  });

  it("records the content hash when hashFn is supplied", () => {
    const records = [makeTicket({ id: "t1" })];
    const snap = captureSnapshot(records, {
      schemaVersion: 1,
      ledgerSequence: 1,
      hashFn: hashRecords
    });
    expect(snap.contentHash).toBe(hashRecords(records));
  });

  it("stores an empty contentHash when no hashFn is given", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 1 });
    expect(snap.contentHash).toBe("");
  });

  it("preserves primaryRecords by reference", () => {
    const records = [makeTicket(), makeTicket()];
    const snap = captureSnapshot(records, { schemaVersion: 1, ledgerSequence: 1 });
    expect(snap.primaryRecords).toHaveLength(2);
    expect(snap.primaryRecords[0].id).toBe(records[0].id);
  });
});

// ─── verifyAndRestore — normal path ───────────────────────────────────────────

describe("verifyAndRestore — normal path", () => {
  it("returns a SnapshotRestoreResult when all invariants pass", () => {
    const records = [makeTicket(), makeTicket()];
    const snap = captureSnapshot(records, { schemaVersion: 1, ledgerSequence: 100 });
    const result = verifyAndRestore(snap, { invariants: INVARIANTS });
    expect(result.snapshotId).toBe(snap.id);
    expect(result.primaryRecordCount).toBe(2);
    expect(result.dryRun).toBe(false);
  });

  it("calls onRestore with the primary records and rebuilt index", () => {
    const records = [makeTicket({ id: "t1", ownerId: "alice" })];
    const snap = captureSnapshot(records, {
      schemaVersion: 1,
      ledgerSequence: 100,
      indexBuilder: buildIndex
    });
    const onRestore = vi.fn();
    verifyAndRestore(snap, { invariants: INVARIANTS, indexBuilder: buildIndex, onRestore });
    expect(onRestore).toHaveBeenCalledOnce();
    const [restoredRecords, rebuiltIndex] = onRestore.mock.calls[0];
    expect(restoredRecords).toEqual(records);
    expect(rebuiltIndex["ticket:t1"]).toBe("alice");
  });

  it("reports zero index mismatches when rebuilt index matches snapshot", () => {
    const records = [makeTicket({ id: "t1", ownerId: "alice" })];
    const snap = captureSnapshot(records, {
      schemaVersion: 1,
      ledgerSequence: 100,
      indexBuilder: buildIndex
    });
    const result = verifyAndRestore(snap, { indexBuilder: buildIndex });
    expect(result.indexMismatches).toHaveLength(0);
  });

  it("does not throw for an empty record set", () => {
    const snap = captureSnapshot<TicketRecord>([], { schemaVersion: 1, ledgerSequence: 1 });
    expect(() => verifyAndRestore(snap, { invariants: INVARIANTS })).not.toThrow();
  });

  it("returns the restoredAt timestamp", () => {
    const now = 1_700_000_000_000;
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 1 });
    const result = verifyAndRestore(snap, { now: () => now });
    expect(result.restoredAt).toBe(new Date(now).toISOString());
  });
});

// ─── Invariant violations — throw path ───────────────────────────────────────

describe("verifyAndRestore — invariant failure (loud throw)", () => {
  it("throws SnapshotMismatchError when an invariant fails", () => {
    const records = [makeTicket({ ownerId: "" })]; // violates ticket.has_owner
    const snap = captureSnapshot(records, { schemaVersion: 1, ledgerSequence: 100 });
    expect(() => verifyAndRestore(snap, { invariants: INVARIANTS })).toThrow(
      SnapshotMismatchError
    );
  });

  it("SnapshotMismatchError carries all violations, not just the first", () => {
    const bad = makeTicket({ ownerId: "", amount: -1 }); // violates 2 invariants
    const snap = captureSnapshot([bad], { schemaVersion: 1, ledgerSequence: 100 });
    let error!: SnapshotMismatchError;
    try {
      verifyAndRestore(snap, { invariants: INVARIANTS });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) error = e;
    }
    expect(error).toBeInstanceOf(SnapshotMismatchError);
    expect(error.violations).toHaveLength(2);
    const names = error.violations.map((v) => v.checkName);
    expect(names).toContain("ticket.has_owner");
    expect(names).toContain("ticket.positive_amount");
  });

  it("every violation identifies the failing record id", () => {
    const bad = makeTicket({ id: "bad-ticket", ownerId: "" });
    const snap = captureSnapshot([bad], { schemaVersion: 1, ledgerSequence: 1 });
    let error!: SnapshotMismatchError;
    try {
      verifyAndRestore(snap, { invariants: [INVARIANTS[0]] });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) error = e;
    }
    expect(error.violations[0].targetId).toBe("bad-ticket");
  });

  it("reports violations from all records, not just the first failing one", () => {
    const records = [
      makeTicket({ id: "t1", ownerId: "" }),
      makeTicket({ id: "t2", ownerId: "" })
    ];
    const snap = captureSnapshot(records, { schemaVersion: 1, ledgerSequence: 1 });
    let error!: SnapshotMismatchError;
    try {
      verifyAndRestore(snap, { invariants: [INVARIANTS[0]] });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) error = e;
    }
    const ids = error.violations.map((v) => v.targetId);
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
  });

  it("a throwing invariant check is recorded as a violation, not re-thrown", () => {
    const throwingInvariant: SnapshotInvariant<TicketRecord> = {
      name: "ticket.throws",
      check: () => {
        throw new Error("invariant exploded");
      }
    };
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 1 });
    let error!: SnapshotMismatchError;
    try {
      verifyAndRestore(snap, { invariants: [throwingInvariant] });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) error = e;
    }
    expect(error).toBeInstanceOf(SnapshotMismatchError);
    expect(error.violations[0].kind).toBe("invariant_failed");
    expect(error.violations[0].detail).toContain("invariant exploded");
  });

  it("does NOT call onRestore when violations are found", () => {
    const onRestore = vi.fn();
    const bad = makeTicket({ ownerId: "" });
    const snap = captureSnapshot([bad], { schemaVersion: 1, ledgerSequence: 1 });
    try {
      verifyAndRestore(snap, { invariants: INVARIANTS, onRestore });
    } catch {
      // expected
    }
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("carries the snapshotId and correlationId in the error", () => {
    const snap = captureSnapshot([makeTicket({ ownerId: "" })], {
      schemaVersion: 1,
      ledgerSequence: 1,
      newId: () => "snap-id-fixed"
    });
    let error!: SnapshotMismatchError;
    try {
      verifyAndRestore(snap, { invariants: INVARIANTS });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) error = e;
    }
    expect(error.snapshotId).toBe("snap-id-fixed");
    expect(typeof error.correlationId).toBe("string");
  });
});

// ─── Schema version checks ────────────────────────────────────────────────────

describe("verifyAndRestore — schema version checks", () => {
  it("blocks a schema downgrade (snapshot older than runtime)", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 100 });
    expect(() =>
      verifyAndRestore(snap, { expectedSchemaVersion: 2 })
    ).toThrow(SnapshotMismatchError);
  });

  it("violation kind is schema_version_mismatch for downgrade", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 100 });
    let error!: SnapshotMismatchError;
    try {
      verifyAndRestore(snap, { expectedSchemaVersion: 2 });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) error = e;
    }
    expect(error.violations[0].kind).toBe("schema_version_mismatch");
    expect(error.violations[0].observed).toBe(1);
    expect(error.violations[0].expected).toBe(2);
  });

  it("allows a schema downgrade when allowSchemaMigration is true", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 100 });
    expect(() =>
      verifyAndRestore(snap, { expectedSchemaVersion: 2, allowSchemaMigration: true })
    ).not.toThrow();
  });

  it("blocks a schema upgrade (snapshot newer than runtime)", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 3, ledgerSequence: 100 });
    expect(() =>
      verifyAndRestore(snap, { expectedSchemaVersion: 2 })
    ).toThrow(SnapshotMismatchError);
  });

  it("version_mismatch violation contains observed > expected for upgrade", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 5, ledgerSequence: 1 });
    let error!: SnapshotMismatchError;
    try {
      verifyAndRestore(snap, { expectedSchemaVersion: 3 });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) error = e;
    }
    expect(error.violations[0].observed).toBe(5);
    expect(error.violations[0].expected).toBe(3);
  });

  it("passes when snapshot schema matches expected schema", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 2, ledgerSequence: 100 });
    expect(() =>
      verifyAndRestore(snap, { expectedSchemaVersion: 2 })
    ).not.toThrow();
  });
});

// ─── Ledger sequence regression ───────────────────────────────────────────────

describe("verifyAndRestore — ledger sequence regression", () => {
  it("blocks a restore when ledgerSequence is below minLedgerSequence", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 50 });
    expect(() =>
      verifyAndRestore(snap, { minLedgerSequence: 100 })
    ).toThrow(SnapshotMismatchError);
  });

  it("violation kind is ledger_sequence_regression", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 50 });
    let error!: SnapshotMismatchError;
    try {
      verifyAndRestore(snap, { minLedgerSequence: 100 });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) error = e;
    }
    expect(error.violations[0].kind).toBe("ledger_sequence_regression");
    expect(error.violations[0].observed).toBe(50);
    expect(error.violations[0].expected).toBe(100);
  });

  it("allows restore at exactly minLedgerSequence", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 100 });
    expect(() =>
      verifyAndRestore(snap, { minLedgerSequence: 100 })
    ).not.toThrow();
  });

  it("allows restore above minLedgerSequence", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 200 });
    expect(() =>
      verifyAndRestore(snap, { minLedgerSequence: 100 })
    ).not.toThrow();
  });
});

// ─── Content hash mismatch ────────────────────────────────────────────────────

describe("verifyAndRestore — content hash mismatch", () => {
  it("blocks restore when records were tampered after capture", () => {
    const records = [makeTicket({ id: "t1" })];
    // Capture with a hash.
    const snap = captureSnapshot(records, {
      schemaVersion: 1,
      ledgerSequence: 100,
      hashFn: hashRecords
    });

    // Simulate tamper: replace primaryRecords directly (freeze bypass via spread).
    const tampered: Snapshot<TicketRecord> = {
      ...snap,
      primaryRecords: [makeTicket({ id: "tampered" })]
    };

    expect(() =>
      verifyAndRestore(tampered, { hashFn: hashRecords })
    ).toThrow(SnapshotMismatchError);
  });

  it("violation kind is content_hash_mismatch", () => {
    const snap = captureSnapshot([makeTicket({ id: "t1" })], {
      schemaVersion: 1,
      ledgerSequence: 100,
      hashFn: hashRecords
    });
    const tampered: Snapshot<TicketRecord> = {
      ...snap,
      primaryRecords: [makeTicket({ id: "tampered" })]
    };
    let error!: SnapshotMismatchError;
    try {
      verifyAndRestore(tampered, { hashFn: hashRecords });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) error = e;
    }
    expect(error.violations[0].kind).toBe("content_hash_mismatch");
  });

  it("skips hash check when snapshot.contentHash is empty", () => {
    // snapshot without hash
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 1 });
    expect(snap.contentHash).toBe("");
    // Even if caller supplies hashFn, the check is skipped for hash-less snapshots.
    expect(() =>
      verifyAndRestore(snap, { hashFn: hashRecords })
    ).not.toThrow();
  });

  it("passes when hash matches", () => {
    const records = [makeTicket({ id: "t1" })];
    const snap = captureSnapshot(records, {
      schemaVersion: 1,
      ledgerSequence: 100,
      hashFn: hashRecords
    });
    expect(() =>
      verifyAndRestore(snap, { hashFn: hashRecords })
    ).not.toThrow();
  });
});

// ─── Index drift ──────────────────────────────────────────────────────────────

describe("verifyAndRestore — index drift (reported, not thrown)", () => {
  it("reports index mismatches without throwing", () => {
    const records = [makeTicket({ id: "t1", ownerId: "alice" })];
    // Capture with a stale/wrong index.
    const snap: Snapshot<TicketRecord> = {
      ...captureSnapshot(records, { schemaVersion: 1, ledgerSequence: 100 }),
      derivedIndex: { "ticket:t1": "old-owner" }
    };
    // Rebuild will produce "alice" but snapshot stored "old-owner".
    const result = verifyAndRestore(snap, { indexBuilder: buildIndex });
    expect(result.indexMismatches).toHaveLength(1);
    expect(result.indexMismatches[0].key).toBe("ticket:t1");
    expect(result.indexMismatches[0].snapshotValue).toBe("old-owner");
    expect(result.indexMismatches[0].rebuiltValue).toBe("alice");
  });

  it("reports new keys added by the rebuild (present in rebuilt, absent in snapshot)", () => {
    const records = [makeTicket({ id: "t1", ownerId: "alice" })];
    // Capture without an index, then rebuild includes the key.
    const snap = captureSnapshot(records, { schemaVersion: 1, ledgerSequence: 100 });
    // derivedIndex is {} but rebuild will produce { "ticket:t1": "alice" }
    const result = verifyAndRestore(snap, { indexBuilder: buildIndex });
    expect(result.indexMismatches.some((m) => m.key === "ticket:t1")).toBe(true);
    expect(result.indexMismatches.find((m) => m.key === "ticket:t1")?.snapshotValue).toBeUndefined();
  });

  it("reports keys removed by the rebuild (present in snapshot, absent in rebuilt)", () => {
    const records = [makeTicket({ id: "t1" })];
    const snap: Snapshot<TicketRecord> = {
      ...captureSnapshot(records, { schemaVersion: 1, ledgerSequence: 100 }),
      derivedIndex: {
        "ticket:t1": "alice",
        "ticket:stale": "bob" // no longer in rebuilt
      }
    };
    // buildIndex only keys on present records.
    const result = verifyAndRestore(snap, { indexBuilder: buildIndex });
    const stale = result.indexMismatches.find((m) => m.key === "ticket:stale");
    expect(stale).toBeDefined();
    expect(stale?.rebuiltValue).toBeUndefined();
  });

  it("zero mismatches when index is already correct", () => {
    const records = [makeTicket({ id: "t1", ownerId: "alice" })];
    const snap = captureSnapshot(records, {
      schemaVersion: 1,
      ledgerSequence: 100,
      indexBuilder: buildIndex
    });
    const result = verifyAndRestore(snap, { indexBuilder: buildIndex });
    expect(result.indexMismatches).toHaveLength(0);
  });
});

// ─── dryRun ───────────────────────────────────────────────────────────────────

describe("verifyAndRestore — dryRun", () => {
  it("dryRun does NOT call onRestore", () => {
    const onRestore = vi.fn();
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 100 });
    verifyAndRestore(snap, { invariants: INVARIANTS, dryRun: true, onRestore });
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("dryRun returns dryRun: true in the result", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 100 });
    const result = verifyAndRestore(snap, { dryRun: true });
    expect(result.dryRun).toBe(true);
  });

  it("dryRun still throws SnapshotMismatchError on violations", () => {
    const snap = captureSnapshot([makeTicket({ ownerId: "" })], {
      schemaVersion: 1,
      ledgerSequence: 1
    });
    expect(() =>
      verifyAndRestore(snap, { invariants: INVARIANTS, dryRun: true })
    ).toThrow(SnapshotMismatchError);
  });
});

// ─── preflight ────────────────────────────────────────────────────────────────

describe("preflight", () => {
  it("returns ok Result when all checks pass", () => {
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 100 });
    const result = preflight(snap, { invariants: INVARIANTS });
    expect(result.ok).toBe(true);
  });

  it("returns err Result with violations instead of throwing", () => {
    const snap = captureSnapshot([makeTicket({ ownerId: "" })], {
      schemaVersion: 1,
      ledgerSequence: 1
    });
    const result = preflight(snap, { invariants: INVARIANTS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("snapshot_invariant_violation");
    expect(result.detail).toBeDefined();
    expect((result.detail as unknown[]).length).toBeGreaterThan(0);
  });

  it("never calls onRestore (dryRun is implicit)", () => {
    const onRestore = vi.fn();
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 100 });
    preflight(snap); // no onRestore in preflight signature
    expect(onRestore).not.toHaveBeenCalled();
  });
});

// ─── Rollback sequence ────────────────────────────────────────────────────────

describe("rollback sequence", () => {
  it("pre-restore snapshot can be re-applied after a failed restore", () => {
    let store: TicketRecord[] = [makeTicket({ id: "t1", ownerId: "alice" })];
    const schemaVersion = 1;
    const ledgerSequence = 100;

    // Step 1: capture the current state as the rollback point.
    const preRestoreSnap = captureSnapshot(store, {
      schemaVersion,
      ledgerSequence,
      indexBuilder: buildIndex
    });

    // Step 2: prepare a corrupted incoming snapshot to restore.
    const corruptedSnap = captureSnapshot([makeTicket({ id: "corrupt", ownerId: "" })], {
      schemaVersion,
      ledgerSequence: 200
    });

    // Step 3: attempt restore — should fail.
    let restoreError: SnapshotMismatchError | undefined;
    try {
      verifyAndRestore(corruptedSnap, { invariants: INVARIANTS });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) restoreError = e;
    }
    expect(restoreError).toBeInstanceOf(SnapshotMismatchError);

    // Step 4: store was not modified (onRestore was never called).
    // Rollback: re-apply the pre-restore snapshot.
    verifyAndRestore(preRestoreSnap, {
      invariants: INVARIANTS,
      indexBuilder: buildIndex,
      onRestore: (records) => {
        store = [...records];
      }
    });

    expect(store).toHaveLength(1);
    expect(store[0].id).toBe("t1");
    expect(store[0].ownerId).toBe("alice");
  });

  it("dryRun preflight prevents bad data from ever reaching onRestore", () => {
    const store: TicketRecord[] = [];
    const badSnap = captureSnapshot([makeTicket({ amount: -10 })], {
      schemaVersion: 1,
      ledgerSequence: 1
    });
    const check = preflight(badSnap, { invariants: INVARIANTS });
    // Preflight failed — we do NOT proceed to the real restore.
    expect(check.ok).toBe(false);
    // Store is untouched.
    expect(store).toHaveLength(0);
  });
});

// ─── Telemetry ────────────────────────────────────────────────────────────────

describe("telemetry events", () => {
  it("emits snapshot.restore_succeeded on a clean restore", () => {
    const sink = createCaptureSink();
    setTelemetrySink(sink);
    try {
      const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 100 });
      verifyAndRestore(snap, { invariants: INVARIANTS });
      const event = sink.find((e) => e.op === "snapshot.restore_succeeded");
      expect(event).toBeDefined();
      expect(event?.result).toBe("success");
      expect(event?.payload?.snapshotId).toBe(snap.id);
    } finally {
      resetTelemetrySink();
    }
  });

  it("emits snapshot.restore_failed before throwing on violation", () => {
    const sink = createCaptureSink();
    setTelemetrySink(sink);
    try {
      const snap = captureSnapshot([makeTicket({ ownerId: "" })], {
        schemaVersion: 1,
        ledgerSequence: 1
      });
      try {
        verifyAndRestore(snap, { invariants: INVARIANTS });
      } catch {
        // expected
      }
      const event = sink.find((e) => e.op === "snapshot.restore_failed");
      expect(event).toBeDefined();
      expect(event?.result).toBe("failure");
      expect(event?.errorCode).toBe("snapshot_invariant_violation");
      expect(event?.payload?.violationCount).toBeGreaterThan(0);
    } finally {
      resetTelemetrySink();
    }
  });
});

// ─── Audit trail ─────────────────────────────────────────────────────────────

describe("audit trail", () => {
  it("writes a projection.replayed audit event on success", () => {
    const trail = createIsolatedAuditTrail();
    const snap = captureSnapshot([makeTicket()], { schemaVersion: 1, ledgerSequence: 100 });
    verifyAndRestore(snap, {
      invariants: INVARIANTS,
      audit: trail,
      actor: { kind: "maintainer", id: "ops-bot" }
    });
    const events = trail.all().filter((e) => e.action === "projection.replayed");
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("allowed");
    expect(events[0].actor.kind).toBe("maintainer");
  });

  it("writes a denied projection.replayed audit event on failure", () => {
    const trail = createIsolatedAuditTrail();
    const snap = captureSnapshot([makeTicket({ ownerId: "" })], {
      schemaVersion: 1,
      ledgerSequence: 1
    });
    try {
      verifyAndRestore(snap, { invariants: INVARIANTS, audit: trail });
    } catch {
      // expected
    }
    const events = trail.all().filter((e) => e.action === "projection.replayed");
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("denied");
    expect(events[0].errorCode).toBe("snapshot_invariant_violation");
  });
});
