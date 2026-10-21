/**
 * Snapshot capture and restore verification for critical data and derived indexes.
 *
 * Context: Utix stores state in the browser (localStorage / in-memory). When a
 * session restores from a snapshot — on re-hydration, after a forced rollback or
 * after a data migration — the raw values that come back may be inconsistent with
 * each other: the primary records may not match what the derived indexes point to,
 * schema versions may have moved on, or the ledger sequence may have regressed.
 *
 * This module provides a two-phase restore workflow:
 *
 *   1. **Capture** (`captureSnapshot`) — takes a point-in-time snapshot of primary
 *      records and their derived index entries. The snapshot is stamped with a
 *      ledger sequence, schema version and a content hash so its integrity can be
 *      checked before restore.
 *
 *   2. **Verify and restore** (`verifyAndRestore`) — given a snapshot, checks every
 *      declared invariant, rebuilds derived indexes from the primary records, and
 *      fails loudly with `SnapshotMismatchError` if any check fails. "Loudly" means
 *      the function throws a `SnapshotMismatchError` (never swallows silently) AND
 *      emits a `snapshot.restore_failed` telemetry event AND writes an audit record
 *      so operators have the full picture.
 *
 * Invariants are supplied by the caller, so this module does not need to know what
 * makes a `TicketRecord` or an `EventRecord` valid. An invariant is a predicate plus
 * a human-readable name; a failing one produces a `SnapshotViolation` that names
 * exactly what broke and on which record.
 *
 * Derived index rebuild
 * ─────────────────────
 * After the invariants pass, the caller may supply an `IndexBuilder` — a function
 * that accepts the restored primary records and returns a fresh index map. This
 * runs deterministically from the primaries (same input → same index) and replaces
 * whatever was in the snapshot's index. If the rebuilt index differs from the
 * snapshot's index, the difference is captured in a `SnapshotIndexMismatch` and
 * surfaced in the result (not thrown, because an index drift is expected during a
 * migration and the caller decides whether it is acceptable).
 *
 * Operational edge cases and recovery
 * ────────────────────────────────────
 * 1. **Invariant violation** — `verifyAndRestore` throws `SnapshotMismatchError`.
 *    Every failing invariant is listed in `error.violations`. The snapshot is NOT
 *    applied; the previous state is intact. Recovery: inspect the violations, fix
 *    the snapshot data, then re-run. Use `dryRun: true` to check without applying.
 *
 * 2. **Schema version regression** — if the snapshot's `schemaVersion` is lower
 *    than the `expectedSchemaVersion` passed to `verifyAndRestore`, a
 *    `schema_version_mismatch` violation is emitted. This blocks the restore until
 *    a migration plan upgrades the snapshot. Recovery: run the relevant migration
 *    and re-capture, or pass `allowSchemaMigration: true` to accept old-schema
 *    restores with a warning.
 *
 * 3. **Ledger sequence regression** — if the snapshot's `ledgerSequence` is older
 *    than `minLedgerSequence`, a `ledger_sequence_regression` violation is added.
 *    This prevents replaying an outdated Stellar state on top of a newer in-memory
 *    state. Recovery: restore from a newer snapshot, or confirm the regression is
 *    intentional and pass a lower `minLedgerSequence`.
 *
 * 4. **Checksum mismatch** — if `captureSnapshot` ran with `hashFn` and the
 *    snapshot's `contentHash` no longer matches the re-hashed primary records,
 *    a `content_hash_mismatch` violation is added. This catches tampering or
 *    accidental partial writes. Recovery: discard the snapshot and re-capture from
 *    a trusted source.
 *
 * 5. **Index drift after rebuild** — the rebuilt index differs from the snapshot's.
 *    This is NOT a hard error: indexes are derived and drifts are expected after a
 *    migration. The `SnapshotRestoreResult.indexMismatches` array describes every
 *    differing key. Callers that need strict index fidelity can check it and refuse.
 *
 * 6. **Rollback** — set `dryRun: true` to validate without writing. A rollback plan:
 *    (a) capture a pre-restore snapshot with `captureSnapshot`, (b) attempt restore
 *    with `verifyAndRestore`, (c) on `SnapshotMismatchError`, re-apply the
 *    pre-restore snapshot. The pre-restore capture is the authoritative rollback
 *    point. See the test file for the rollback sequence.
 *
 * Compatibility
 * ─────────────
 * This module adds no new fields to `ArchiveRecord` or any other existing type.
 * `Snapshot` is a new standalone type; `verifyAndRestore` returns a new
 * `SnapshotRestoreResult` type. No existing API is changed.
 */

import {
  recordAudit,
  type AuditActor,
  type AuditInput,
  type AuditTrail
} from "@/core/audit/audit";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";

// ─── Core types ───────────────────────────────────────────────────────────────

export type SnapshotErrorCode =
  | "snapshot_invariant_violation"
  | "snapshot_schema_mismatch"
  | "snapshot_ledger_regression"
  | "snapshot_hash_mismatch"
  | "snapshot_empty"
  | "snapshot_unauthorized";

export type SnapshotViolationKind =
  | "invariant_failed"
  | "schema_version_mismatch"
  | "ledger_sequence_regression"
  | "content_hash_mismatch";

export interface SnapshotViolation {
  /** Machine-readable kind, stable for switch statements. */
  readonly kind: SnapshotViolationKind;
  /** Which invariant or check produced this violation. */
  readonly checkName: string;
  /** The record ID that failed, or `"snapshot"` for top-level checks. */
  readonly targetId: string;
  /** Human-readable description of exactly what failed. */
  readonly detail: string;
  /** The value that was observed (serialisable). */
  readonly observed?: unknown;
  /** The value that was expected (serialisable). */
  readonly expected?: unknown;
}

/**
 * Thrown (never returned) when `verifyAndRestore` detects a violation.
 * Thrown rather than returned because a partial restore is a data-integrity
 * failure: the caller must handle it, and an uncaught throw surfaces it
 * loudly rather than letting it silently propagate as an `ok: false`.
 */
export class SnapshotMismatchError extends Error {
  readonly violations: readonly SnapshotViolation[];
  readonly snapshotId: string;
  readonly correlationId: string;

  constructor(
    violations: readonly SnapshotViolation[],
    snapshotId: string,
    correlationId: string
  ) {
    const summary = violations
      .slice(0, 3)
      .map((v) => `[${v.kind}] ${v.checkName}: ${v.detail}`)
      .join("; ");
    const more = violations.length > 3 ? ` (and ${violations.length - 3} more)` : "";
    super(`Snapshot restore verification failed — ${violations.length} violation(s): ${summary}${more}`);
    this.name = "SnapshotMismatchError";
    this.violations = violations;
    this.snapshotId = snapshotId;
    this.correlationId = correlationId;
  }
}

/**
 * An invariant the caller wants enforced on every primary record.
 *
 * @example
 * ```ts
 * const hasOwner: SnapshotInvariant<TicketRecord> = {
 *   name: "ticket.has_owner",
 *   check: (record) => typeof record.ownerId === "string" && record.ownerId.length > 0
 * };
 * ```
 */
export interface SnapshotInvariant<T> {
  /** Stable dot-separated name used in violation reports and telemetry. */
  readonly name: string;
  /** Returns `true` if the record satisfies the invariant. */
  readonly check: (record: T) => boolean;
  /** Optional human-readable description included in violation detail. */
  readonly description?: string;
}

/** A key→value index built from primary records. */
export type DerivedIndex = Record<string, string>;

/**
 * Builds a derived index from a set of primary records. Called after all
 * invariants pass; the result replaces whatever the snapshot stored.
 */
export type IndexBuilder<T> = (records: readonly T[]) => DerivedIndex;

export interface SnapshotIndexMismatch {
  /** The index key that differs. */
  readonly key: string;
  /** What the snapshot stored (undefined if the key is new). */
  readonly snapshotValue: string | undefined;
  /** What the rebuild produced (undefined if the key was removed). */
  readonly rebuiltValue: string | undefined;
}

/** A point-in-time snapshot of primary records and their derived index. */
export interface Snapshot<T> {
  /** Unique stable ID for this snapshot. */
  readonly id: string;
  readonly schemaVersion: number;
  /**
   * Stellar ledger sequence at capture time. Used to detect regressions:
   * restoring a snapshot from an older ledger on top of newer in-memory state
   * is a data-integrity risk.
   */
  readonly ledgerSequence: number;
  readonly capturedAt: string;
  readonly primaryRecords: readonly T[];
  /**
   * Index entries at capture time. These may differ from what a fresh rebuild
   * produces (e.g. after a migration); the difference is reported, not fatal.
   */
  readonly derivedIndex: DerivedIndex;
  /**
   * Optional content hash produced by the `hashFn` supplied to
   * `captureSnapshot`. Empty string when no hash function was provided.
   */
  readonly contentHash: string;
  /** Free-form context for operators. Never contains secrets. */
  readonly metadata: Record<string, string | number | boolean>;
}

export interface CaptureOptions<T> {
  schemaVersion: number;
  ledgerSequence: number;
  /**
   * Index builder used to create `derivedIndex` at capture time. If not
   * provided, `derivedIndex` will be an empty object.
   */
  indexBuilder?: IndexBuilder<T>;
  /**
   * Deterministic hash of the primary records. Used to detect post-capture
   * tampering. If not provided, `contentHash` will be an empty string.
   */
  hashFn?: (records: readonly T[]) => string;
  metadata?: Record<string, string | number | boolean>;
  /** Injected ID factory. Defaults to `newCorrelationId`. */
  newId?: () => string;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
}

export interface VerifyOptions<T> {
  /**
   * Invariants every primary record must satisfy.
   * A single failing record produces a violation entry, not an early exit,
   * so all violations are reported together.
   */
  invariants?: readonly SnapshotInvariant<T>[];
  /** The schema version the restore target expects. Defaults to `snapshot.schemaVersion`. */
  expectedSchemaVersion?: number;
  /**
   * When set, a snapshot whose `ledgerSequence` is strictly less than this
   * value is refused with a `ledger_sequence_regression` violation.
   */
  minLedgerSequence?: number;
  /**
   * When `true`, schema version downgrades are allowed (emit a warning
   * violation that does not block the restore).
   */
  allowSchemaMigration?: boolean;
  /**
   * Rebuild the derived index and compare against the snapshot's stored index.
   * Differences are reported in `indexMismatches` but do not throw.
   */
  indexBuilder?: IndexBuilder<T>;
  /**
   * Re-hash the primary records and compare against `snapshot.contentHash`.
   * Only checked when `snapshot.contentHash` is non-empty.
   */
  hashFn?: (records: readonly T[]) => string;
  /**
   * When `true`, validate everything but do NOT call `onRestore`. Use this
   * to implement a pre-flight check before committing.
   */
  dryRun?: boolean;
  /**
   * Called with the verified primary records and rebuilt index when the
   * restore passes all checks and `dryRun` is false. This is the commit step.
   */
  onRestore?: (records: readonly T[], index: DerivedIndex) => void;
  /** Audit actor for the restore record. Defaults to `system`. */
  actor?: AuditActor;
  /** Injected audit trail. Defaults to the app-wide trail via `recordAudit`. */
  audit?: AuditTrail;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
}

export interface SnapshotRestoreResult<T> {
  readonly snapshotId: string;
  readonly schemaVersion: number;
  readonly ledgerSequence: number;
  readonly primaryRecordCount: number;
  readonly rebuiltIndex: DerivedIndex;
  readonly indexMismatches: readonly SnapshotIndexMismatch[];
  readonly dryRun: boolean;
  readonly restoredAt: string;
  readonly correlationId: string;
}

// ─── Capture ──────────────────────────────────────────────────────────────────

/**
 * Captures a point-in-time snapshot of `records`.
 *
 * The returned `Snapshot` is immutable and self-describing: it carries the
 * schema version, ledger sequence and (optionally) a content hash so its
 * integrity can be verified before restore.
 */
export function captureSnapshot<T>(
  records: readonly T[],
  options: CaptureOptions<T>
): Snapshot<T> {
  const nowFn = options.now ?? (() => Date.now());
  const newId = options.newId ?? newCorrelationId;
  const derivedIndex = options.indexBuilder ? options.indexBuilder(records) : {};
  const contentHash = options.hashFn ? options.hashFn(records) : "";

  return {
    id: newId(),
    schemaVersion: options.schemaVersion,
    ledgerSequence: options.ledgerSequence,
    capturedAt: new Date(nowFn()).toISOString(),
    primaryRecords: records,
    derivedIndex,
    contentHash,
    metadata: options.metadata ?? {}
  };
}

// ─── Verify and restore ───────────────────────────────────────────────────────

/**
 * Verifies a snapshot against declared invariants and restores it if all
 * checks pass.
 *
 * Throws `SnapshotMismatchError` on any hard failure (invariant violation,
 * schema regression, ledger regression, hash mismatch). Returns
 * `SnapshotRestoreResult` on success. Index drift is reported but does not
 * throw.
 *
 * The caller supplies `onRestore` to commit the records. This function never
 * writes state directly; it is a verification pipeline, not a storage layer.
 */
export function verifyAndRestore<T>(
  snapshot: Snapshot<T>,
  options: VerifyOptions<T> = {}
): SnapshotRestoreResult<T> {
  const correlationId = newCorrelationId();
  const nowFn = options.now ?? (() => Date.now());
  const at = new Date(nowFn()).toISOString();
  const actor: AuditActor = options.actor ?? { kind: "system" };

  /** Use injected audit trail when available; fall back to app-wide singleton. */
  function audit(input: AuditInput): void {
    if (options.audit) {
      options.audit.record(input);
    } else {
      recordAudit(input);
    }
  }

  const violations: SnapshotViolation[] = [];

  // ── Phase 1: Top-level snapshot integrity checks ──────────────────────────

  // 1a. Schema version check
  const expectedSchema = options.expectedSchemaVersion ?? snapshot.schemaVersion;
  if (snapshot.schemaVersion < expectedSchema && !options.allowSchemaMigration) {
    violations.push({
      kind: "schema_version_mismatch",
      checkName: "snapshot.schema_version",
      targetId: "snapshot",
      detail: `Snapshot schema v${snapshot.schemaVersion} is older than expected v${expectedSchema}. Pass allowSchemaMigration: true if this is an intentional migration.`,
      observed: snapshot.schemaVersion,
      expected: expectedSchema
    });
  }
  if (snapshot.schemaVersion > expectedSchema) {
    // A snapshot from a newer schema cannot be safely restored to an older
    // runtime — the primary records may contain fields the current code cannot
    // handle.
    violations.push({
      kind: "schema_version_mismatch",
      checkName: "snapshot.schema_version",
      targetId: "snapshot",
      detail: `Snapshot schema v${snapshot.schemaVersion} is newer than runtime v${expectedSchema}. Upgrade the application before restoring this snapshot.`,
      observed: snapshot.schemaVersion,
      expected: expectedSchema
    });
  }

  // 1b. Ledger sequence regression check
  if (
    typeof options.minLedgerSequence === "number" &&
    snapshot.ledgerSequence < options.minLedgerSequence
  ) {
    violations.push({
      kind: "ledger_sequence_regression",
      checkName: "snapshot.ledger_sequence",
      targetId: "snapshot",
      detail: `Snapshot ledger sequence ${snapshot.ledgerSequence} is below minimum ${options.minLedgerSequence}. Restoring this snapshot would regress in-memory Stellar state.`,
      observed: snapshot.ledgerSequence,
      expected: options.minLedgerSequence
    });
  }

  // 1c. Content hash check (only when the snapshot carries one)
  if (snapshot.contentHash && options.hashFn) {
    const recomputed = options.hashFn(snapshot.primaryRecords);
    if (recomputed !== snapshot.contentHash) {
      violations.push({
        kind: "content_hash_mismatch",
        checkName: "snapshot.content_hash",
        targetId: "snapshot",
        detail: `Snapshot content hash does not match the recomputed hash of its primary records. The snapshot may have been tampered with or partially written.`,
        observed: recomputed,
        expected: snapshot.contentHash
      });
    }
  }

  // ── Phase 2: Per-record invariant checks ──────────────────────────────────

  if (options.invariants && options.invariants.length > 0) {
    for (const record of snapshot.primaryRecords) {
      // Derive a string ID from the record for violation attribution.
      const recordId =
        typeof (record as Record<string, unknown>)["id"] === "string"
          ? (record as Record<string, unknown>)["id"] as string
          : JSON.stringify(record).slice(0, 64);

      for (const invariant of options.invariants) {
        let passed = false;
        try {
          passed = invariant.check(record);
        } catch (checkError) {
          // A throwing invariant counts as a failed check — never silenced.
          passed = false;
          violations.push({
            kind: "invariant_failed",
            checkName: invariant.name,
            targetId: recordId,
            detail: `Invariant "${invariant.name}" threw during check: ${checkError instanceof Error ? checkError.message : String(checkError)}`,
            observed: "exception"
          });
          continue;
        }

        if (!passed) {
          violations.push({
            kind: "invariant_failed",
            checkName: invariant.name,
            targetId: recordId,
            detail:
              invariant.description ??
              `Record "${recordId}" failed invariant "${invariant.name}".`
          });
        }
      }
    }
  }

  // ── Phase 3: Loud failure on hard violations ──────────────────────────────

  if (violations.length > 0) {
    // Emit telemetry first — so even an uncaught throw leaves a trace.
    emitTelemetry({
      op: "snapshot.restore_failed",
      actorType: "system",
      result: "failure",
      correlationId,
      errorCode: "snapshot_invariant_violation",
      payload: {
        snapshotId: snapshot.id,
        schemaVersion: snapshot.schemaVersion,
        ledgerSequence: snapshot.ledgerSequence,
        recordCount: snapshot.primaryRecords.length,
        violationCount: violations.length,
        violationKinds: [...new Set(violations.map((v) => v.kind))]
      }
    });

    // Audit the failure so the trail shows what broke and on which snapshot.
    audit({
      action: "projection.replayed",
      actor,
      scope: "maintainer",
      target: { kind: "snapshot", id: snapshot.id },
      outcome: "denied",
      reason: "restore_verification_failed",
      after: {
        violationCount: violations.length,
        schemaVersion: snapshot.schemaVersion,
        ledgerSequence: snapshot.ledgerSequence
      },
      at,
      correlationId,
      errorCode: "snapshot_invariant_violation"
    });

    // Throw — never return an ok() — so a caller that forgets to check the
    // result still surfaces the failure.
    throw new SnapshotMismatchError(violations, snapshot.id, correlationId);
  }

  // ── Phase 4: Derive index and compare ────────────────────────────────────

  const rebuiltIndex: DerivedIndex = options.indexBuilder
    ? options.indexBuilder(snapshot.primaryRecords)
    : { ...snapshot.derivedIndex };

  const indexMismatches: SnapshotIndexMismatch[] = [];

  if (options.indexBuilder) {
    // Keys present in snapshot but missing or changed in rebuild.
    for (const [key, snapshotValue] of Object.entries(snapshot.derivedIndex)) {
      const rebuiltValue = rebuiltIndex[key];
      if (rebuiltValue !== snapshotValue) {
        indexMismatches.push({
          key,
          snapshotValue,
          rebuiltValue: rebuiltValue ?? undefined
        });
      }
    }
    // Keys present in rebuild but absent in snapshot.
    for (const [key, rebuiltValue] of Object.entries(rebuiltIndex)) {
      if (!(key in snapshot.derivedIndex)) {
        indexMismatches.push({ key, snapshotValue: undefined, rebuiltValue });
      }
    }
  }

  // ── Phase 5: Commit (if not dry-run) ──────────────────────────────────────

  if (!options.dryRun && options.onRestore) {
    options.onRestore(snapshot.primaryRecords, rebuiltIndex);
  }

  // ── Phase 6: Emit success telemetry and audit ─────────────────────────────

  const restoredAt = new Date(nowFn()).toISOString();

  emitTelemetry({
    op: "snapshot.restore_succeeded",
    actorType: "system",
    result: "success",
    correlationId,
    payload: {
      snapshotId: snapshot.id,
      schemaVersion: snapshot.schemaVersion,
      ledgerSequence: snapshot.ledgerSequence,
      recordCount: snapshot.primaryRecords.length,
      indexMismatchCount: indexMismatches.length,
      dryRun: options.dryRun ?? false
    }
  });

  audit({
    action: "projection.replayed",
    actor,
    scope: "maintainer",
    target: { kind: "snapshot", id: snapshot.id },
    outcome: "allowed",
    reason: options.dryRun ? "restore_dry_run" : "restore_verified",
    after: {
      schemaVersion: snapshot.schemaVersion,
      ledgerSequence: snapshot.ledgerSequence,
      recordCount: snapshot.primaryRecords.length,
      indexMismatchCount: indexMismatches.length,
      dryRun: options.dryRun ?? false
    },
    at: restoredAt,
    correlationId
  });

  return {
    snapshotId: snapshot.id,
    schemaVersion: snapshot.schemaVersion,
    ledgerSequence: snapshot.ledgerSequence,
    primaryRecordCount: snapshot.primaryRecords.length,
    rebuiltIndex,
    indexMismatches,
    dryRun: options.dryRun ?? false,
    restoredAt,
    correlationId
  };
}

// ─── Convenience: dry-run pre-flight ──────────────────────────────────────────

/**
 * Validates a snapshot without committing. Returns a `Result` instead of
 * throwing so callers can introspect violations without a try/catch.
 *
 * Internally calls `verifyAndRestore` with `dryRun: true` and catches
 * `SnapshotMismatchError`. All other errors are re-thrown.
 */
export function preflight<T>(
  snapshot: Snapshot<T>,
  options: Omit<VerifyOptions<T>, "dryRun" | "onRestore"> = {}
): Result<SnapshotRestoreResult<T>, SnapshotErrorCode, readonly SnapshotViolation[]> {
  try {
    const result = verifyAndRestore(snapshot, { ...options, dryRun: true });
    return ok(result);
  } catch (error) {
    if (error instanceof SnapshotMismatchError) {
      return err("snapshot_invariant_violation", error.violations);
    }
    throw error;
  }
}
