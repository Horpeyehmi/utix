/**
 * Audit-grade event trail for sensitive user and maintainer actions.
 *
 * Some actions in Utix matter more than others: dead-lettering a job, retrying
 * one, generating an export with maintainer scope, clearing a user's
 * notifications, publishing a report that someone else will act on. When
 * something goes wrong, the question is always the same — *who did this, on
 * what, and why?* Telemetry answers it for machines and is best-effort;
 * telemetry is not an audit trail.
 *
 * This module is the audit trail. Its rules:
 *
 * - **one structured event per sensitive action**, written at the domain
 *   boundary (in the lifecycle table, the export workflow, the notification
 *   store, the reconciliation job), not by the UI;
 * - **every event carries attribution**: `action`, `actor` (kind and id),
 *   `scope`, `target`, `reason` when one applies, `at`, `correlationId` and
 *   an `outcome` of `allowed` or `denied`;
 * - **before/after are small and scalar**. A finding cannot smuggle a payload
 *   into the trail: values must be primitives, keys are capped, and everything
 *   passes through `redact()` and an embedded-secret scrub on the way in;
 * - **the trail is append-only**. There is no update and no per-event delete,
 *   only retention pruning of the oldest entries;
 * - **reading it is authorized**: a `user` actor sees only their own `own`
 *   scope, a `maintainer` sees everything. Anything else is `audit_denied`.
 *
 * The clock, the id factory and the storage are injected, so a test can assert
 * an exact trail.
 */

import { err, ok, type Result } from "@/core/result/result";
import { newCorrelationId, redact } from "@/core/telemetry/telemetry";
// Cyclic with core/ledger/ledger.ts; both are only used inside functions here.
import { getLedger, ledgerInputForAudit, type Ledger } from "@/core/ledger/ledger";

export type AuditErrorCode = "audit_denied" | "invalid_audit_field" | "invalid_filter" | "audit_not_found";

/**
 * The sensitive actions that require an audit record. Declared once so docs,
 * tests and the emitters cannot disagree about the coverage.
 */
export const SENSITIVE_ACTIONS = [
  /** A core record moved state through the lifecycle table. */
  "record.state_changed",
  /** A lifecycle move was refused. */
  "record.transition_denied",
  /** An export envelope was generated (or refused). */
  "export.generated",
  /** A notification was published to a recipient. */
  "notification.published",
  /** Every notification for a recipient was removed. */
  "notification.cleared",
  /** A reconciliation dry run produced a report. */
  "reconciliation.reported",
  /** An approved repair plan applied, reverted or was refused. */
  "reconciliation.repaired",
  /** An in-flight idempotency claim was released for a retry. */
  "idempotency.claim_released",
  /** A maintainer raised, lowered or blocked a quota for a principal or globally. */
  "quota.override_granted",
  /** A maintainer removed a quota override before it expired. */
  "quota.override_revoked",
  /** A maintainer raised, lowered or blocked a quota for a principal or globally. */
  "quota.override_granted",
  /** A maintainer removed a quota override before it expired. */
  "quota.override_revoked",
  /** A projection was rebuilt or caught up from the event log (or the run failed). */
  "projection.replayed",
  /** A projection's active version was promoted or rolled back. */
  "projection.activated",
  /** Administrative configuration was changed (or a change was refused). */
  "admin.config_changed",
  /** A maintainer opened a scoped support-access session. */
  "impersonation.session_started",
  /** A maintainer closed a support-access session. */
  "impersonation.session_ended",
  /** A support-access session expired before the maintainer closed it. */
  "impersonation.session_expired",
  /** A permitted action ran inside a support-access session (or was refused). */
  "impersonation.action",
  /** A dangerous mutation was blocked inside a read-only support session. */
  "impersonation.mutation_blocked",
  /** A delegated permission was granted (or a grant was refused). */
  "authorization.granted",
  /** A delegated permission was renewed (or a renewal was refused). */
  "authorization.renewed",
  /** A delegated permission was revoked (or a revocation was refused). */
  "authorization.revoked",
  /** A stale delegated permission was removed by cleanup (or cleanup was refused). */
  "authorization.cleaned_up",
  /** A recipient's notification preferences were changed (or the change was refused). */
  "notification_preferences.updated",
  /** A recipient's notification preferences were reset to defaults. */
  "notification_preferences.reset",
  /** An optional notification was suppressed by the recipient's preferences. */
  "notification.suppressed_by_preference",
  /** A mandatory alert was delivered despite the recipient's preferences. */
  "notification.mandatory_override",
  /** A freeze window was bypassed for an emergency action. */
  "freeze.bypassed",
  /** An emergency bypass of a freeze window was refused. */
  "freeze.bypass_denied",
  /** The public service mode (degraded, paused, maintenance) was changed or a change was refused. */
  "service_mode.changed",
  /** A service mode reached its `until` and returned to normal on its own. */
  "service_mode.expired"
] as const;

export type AuditAction = (typeof SENSITIVE_ACTIONS)[number];

export type AuditActor =
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "maintainer"; readonly id: string }
  | { readonly kind: "system"; readonly id?: string };

/** `own` is scoped to one principal; `maintainer` is repository-wide. */
export type AuditScope = "own" | "maintainer";

export type AuditOutcome = "allowed" | "denied";

/** Before/after context: primitives only, and never a whole payload. */
export type AuditContext = Record<string, string | number | boolean | null>;

export interface AuditTarget {
  /** Record kind, e.g. `worker_job`. */
  readonly kind: string;
  readonly id: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly action: AuditAction;
  readonly actor: AuditActor;
  readonly actorId: string;
  readonly scope: AuditScope;
  readonly target: AuditTarget;
  /** Why the action was taken. Required by the caller when it knows. */
  readonly reason?: string;
  readonly outcome: AuditOutcome;
  readonly before?: AuditContext;
  readonly after?: AuditContext;
  /** ISO-8601 instant, injected. */
  readonly at: string;
  readonly correlationId: string;
  /** The failure code when `outcome` is `denied`. */
  readonly errorCode?: string;
}

export interface AuditStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const AUDIT_STORAGE_PREFIX = "utix:audit:v1:";

/** How many events are retained. The trail is a review aid, not a data lake. */
export const AUDIT_DEFAULT_LIMIT = 500;

/** Cap on before/after keys, so an event stays readable. */
export const AUDIT_MAX_CONTEXT_KEYS = 12;

const AUDIT_MAX_VALUE_LENGTH = 160;

/** A Stellar secret (seed) embedded in a longer string. */
const EMBEDDED_SECRET = /\b[SM][A-Z2-7]{55}\b/g;
const EMBEDDED_BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+\b/gi;
const SENSITIVE_KEY_PATTERN = /secret|seed|key|token|password|passphrase|auth|credential|bearer|cookie/i;

const REASON_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

/** A target needs a kind and an id, both non-empty and short. */
function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

export interface AuditInput {
  action: AuditAction;
  actor: AuditActor;
  scope?: AuditScope;
  target: AuditTarget;
  reason?: string;
  outcome?: AuditOutcome;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  at?: string;
  correlationId?: string;
  errorCode?: string;
}

function scrubSecrets(value: string): string {
  return value
    .replace(EMBEDDED_SECRET, "[REDACTED]")
    .replace(EMBEDDED_BEARER, "[REDACTED]");
}

/**
 * Normalises a before/after map: primitives only, values truncated, secrets
 * removed. Anything else is dropped rather than serialised, which is what
 * keeps a private payload out of a durable record.
 */
export function auditContext(value: Record<string, unknown> | undefined): AuditContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: AuditContext = {};
  let keys = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (keys >= AUDIT_MAX_CONTEXT_KEYS) break;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
      keys += 1;
      continue;
    }
    if (entry === undefined || entry === null) {
      out[key] = null;
      keys += 1;
      continue;
    }
    if (typeof entry === "object" || typeof entry === "function") continue;
    if (typeof entry === "string") {
      out[key] = scrubSecrets(entry).slice(0, AUDIT_MAX_VALUE_LENGTH);
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      out[key] = entry;
    } else if (typeof entry === "boolean") {
      out[key] = entry;
    } else {
      continue;
    }
    keys += 1;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (SENSITIVE_ACTIONS as readonly string[]).includes(value);
}

function isEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AuditEvent>;
  return (
    typeof item.id === "string" &&
    isAction(item.action) &&
    typeof item.actorId === "string" &&
    (item.scope === "own" || item.scope === "maintainer") &&
    typeof item.target?.kind === "string" &&
    typeof item.target?.id === "string" &&
    (item.outcome === "allowed" || item.outcome === "denied") &&
    typeof item.at === "string" &&
    typeof item.correlationId === "string"
  );
}

function memoryStorage(): AuditStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key)
  };
}

function browserStorage(): AuditStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    return memoryStorage();
  }
  return memoryStorage();
}

export interface AuditOptions {
  storage?: AuditStorage;
  limit?: number;
  now?: () => number;
  newId?: () => string;
  /**
   * Tamper-evident ledger every recorded event is committed to (see
   * `core/ledger/`). The app-wide trail uses the app-wide ledger; a trail
   * created without one is not anchored.
   */
  ledger?: Pick<Ledger, "append">;
}

export interface AuditFilter {
  action?: AuditAction;
  actorId?: string;
  targetKind?: string;
  targetId?: string;
  outcome?: AuditOutcome;
  /** ISO-8601 lower bound, inclusive. */
  from?: string;
  /** ISO-8601 upper bound, exclusive. */
  to?: string;
  limit?: number;
}

export interface AuditPage {
  events: readonly AuditEvent[];
  total: number;
  hasMore: boolean;
}

export type AuditExportFormat = "json" | "ndjson" | "csv";

export interface AuditExportOptions extends AuditFilter {
  format?: AuditExportFormat;
  limit?: number;
}

export interface AuditTrail {
  /** Appends one event. The only write. */
  record(input: AuditInput): Result<AuditEvent, AuditErrorCode>;
  /**
   * Reads the trail. A `user` actor is confined to its own `own`-scope events;
   * anything wider is `audit_denied`.
   */
  query(actor: AuditActor, filter?: AuditFilter): Result<AuditPage, AuditErrorCode>;
  /** Authorized, redacted export for a maintainer review. */
  export(actor: AuditActor, options?: AuditExportOptions): Result<string, AuditErrorCode>;
  /** Drops the oldest events beyond the retention limit. */
  prune(): number;
  /** Every retained event, oldest first. Test seam and CLI helper. */
  all(): readonly AuditEvent[];
  reset(): void;
}

/** Authorizes a read. A plain user may only read its own `own`-scope events. */
export function authorizeAuditRead(
  actor: AuditActor,
  requestedScope: AuditScope
): Result<AuditScope, "audit_denied"> {
  if (actor.kind === "maintainer") return ok(requestedScope);
  if (requestedScope === "maintainer") return err("audit_denied");
  if (actor.kind !== "user" || !actor.id) return err("audit_denied");
  return ok("own");
}

function matches(event: AuditEvent, filter: AuditFilter): boolean {
  if (filter.action && event.action !== filter.action) return false;
  if (filter.actorId && event.actorId !== filter.actorId) return false;
  if (filter.targetKind && event.target.kind !== filter.targetKind) return false;
  if (filter.targetId && event.target.id !== filter.targetId) return false;
  if (filter.outcome && event.outcome !== filter.outcome) return false;
  if (filter.from && event.at < filter.from) return false;
  if (filter.to && event.at >= filter.to) return false;
  return true;
}

function toCsv(events: readonly AuditEvent[]): string {
  const columns = [
    "at",
    "action",
    "outcome",
    "actorKind",
    "actorId",
    "scope",
    "targetKind",
    "targetId",
    "reason",
    "errorCode",
    "before",
    "after",
    "correlationId"
  ] as const;

  const escape = (value: string | number | boolean | null | undefined): string => {
    if (value === undefined || value === null) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const rows = events.map((event) =>
    [
      event.at,
      event.action,
      event.outcome,
      event.actor.kind,
      event.actorId,
      event.scope,
      event.target.kind,
      event.target.id,
      event.reason,
      event.errorCode,
      event.before ? JSON.stringify(event.before) : undefined,
      event.after ? JSON.stringify(event.after) : undefined,
      event.correlationId
    ]
      .map(escape)
      .join(",")
  );

  return [columns.join(","), ...rows].join("\n");
}

export function createAuditTrail(options: AuditOptions = {}): AuditTrail {
  const limit = Math.max(1, Math.floor(options.limit ?? AUDIT_DEFAULT_LIMIT));
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? newCorrelationId;
  const storage = options.storage ?? browserStorage();
  const key = `${AUDIT_STORAGE_PREFIX}events`;

  function readAll(): AuditEvent[] {
    const raw = storage.getItem(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isEvent);
    } catch {
      return [];
    }
  }

  function writeAll(events: readonly AuditEvent[]): void {
    // Redaction at the boundary: nothing unscrubbed is ever persisted.
    storage.setItem(key, JSON.stringify(redact(events)));
  }

  /**
   * Commits the stored form of an event to the ledger. A ledger that refuses
   * (broken chain, full storage) never fails the audit write: the event is
   * still in the trail, and `verifyAuditTrail` reports it as unanchored.
   */
  function commitToLedger(event: AuditEvent): void {
    if (!options.ledger) return;
    try {
      const stored = JSON.parse(JSON.stringify(redact(event))) as AuditEvent;
      options.ledger.append(ledgerInputForAudit(stored));
    } catch {
      // Best effort by design; see above.
    }
  }

  return {
    record(input: AuditInput): Result<AuditEvent, AuditErrorCode> {
      if (!isAction(input.action)) return err("invalid_audit_field");
      if (!input.target || !isLabel(input.target.kind) || !isLabel(input.target.id)) {
        return err("invalid_audit_field");
      }
      if (!input.actor || typeof input.actor.kind !== "string") return err("invalid_audit_field");
      if (input.reason !== undefined && !REASON_PATTERN.test(input.reason)) {
        return err("invalid_audit_field");
      }

      const actorId = input.actor.id ?? input.actor.kind;
      const event: AuditEvent = {
        id: newId(),
        action: input.action,
        actor: input.actor,
        actorId,
        scope: input.scope ?? (input.actor.kind === "maintainer" ? "maintainer" : "own"),
        target: { kind: input.target.kind, id: scrubSecrets(input.target.id) },
        reason: input.reason,
        outcome: input.outcome ?? "allowed",
        before: auditContext(input.before),
        after: auditContext(input.after),
        at: input.at ?? new Date(now()).toISOString(),
        correlationId: input.correlationId ?? newId(),
        errorCode: input.errorCode
      };

      if (!isEvent(event)) return err("invalid_audit_field");

      // Append-only: the previous events are never rewritten, only extended.
      writeAll([...readAll(), event]);
      commitToLedger(event);
      return ok(event);
    },

    query(actor: AuditActor, filter: AuditFilter = {}): Result<AuditPage, AuditErrorCode> {
      const scope = authorizeAuditRead(actor, filter.actorId ? "maintainer" : "own");
      if (!scope.ok) return scope;
      if (actor.kind !== "maintainer" && filter.actorId && filter.actorId !== actor.id) {
        return err("audit_denied");
      }

      const all = readAll();
      // A maintainer sees everything. A user sees only its own `own`-scope
      // events — a maintainer-scope event is never readable by a user, not even
      // one they caused.
      const visible = all.filter((event) =>
        actor.kind === "maintainer" ? true : event.scope === "own" && event.actorId === actor.id
      );

      const matched = visible.filter((event) => matches(event, filter));
      const cap = Math.max(1, Math.floor(filter.limit ?? limit));
      const events = matched.slice(Math.max(0, matched.length - cap));
      return ok({ events, total: matched.length, hasMore: matched.length > events.length });
    },

    export(actor: AuditActor, exportOptions: AuditExportOptions = {}): Result<string, AuditErrorCode> {
      const { format = "ndjson", ...filter } = exportOptions;
      const page = this.query(actor, filter);
      if (!page.ok) return page;
      const events = page.value.events;
      if (format === "json") return ok(JSON.stringify({ schemaVersion: "1.0", events }, null, 2));
      if (format === "csv") return ok(toCsv(events));
      return ok(events.map((event) => JSON.stringify(event)).join("\n"));
    },

    prune(): number {
      const all = readAll();
      if (all.length <= limit) return 0;
      const kept = all.slice(all.length - limit);
      writeAll(kept);
      return all.length - kept.length;
    },

    all(): readonly AuditEvent[] {
      return readAll();
    },

    reset(): void {
      storage.removeItem(key);
    }
  };
}

let singleton: AuditTrail | undefined;

/** The app-wide trail. One per session, like the maintenance framework. */
export function getAuditTrail(): AuditTrail {
  if (!singleton) singleton = createAuditTrail({ ledger: getLedger() });
  return singleton;
}

/** Test seam: a fresh, isolated trail. */
export function createIsolatedAuditTrail(options: AuditOptions = {}): AuditTrail {
  return createAuditTrail({ storage: memoryStorage(), ...options });
}

/**
 * Records an event on the app-wide trail and returns it, or `undefined` when
 * the input was rejected. Emitters use this so a malformed context can never
 * throw through a domain path.
 */
export function recordAudit(input: AuditInput): AuditEvent | undefined {
  const recorded = getAuditTrail().record(input);
  return recorded.ok ? recorded.value : undefined;
}

/**
 * Lifecycle events that are sensitive whatever the actor: the record stops, is
 * handed off, or is destroyed. A job that dead-letters or exhausts its budget
 * is exactly what a maintainer reviews later.
 */
export const AUDITED_LIFECYCLE_EVENTS = new Set([
  "dead_letter",
  "exhaust",
  "purge",
  "archive",
  "expire"
]);

/**
 * Events that are only sensitive when a human asked for them. A handler that
 * threw and a worker that backed off are routine operations already covered by
 * telemetry; a maintainer forcing a failure or a retry is an action.
 */
export const AUDITED_MANUAL_EVENTS = new Set(["retry", "fail"]);

/**
 * Whether a lifecycle move belongs in the trail. Terminal and irreversible
 * moves always do; a retry or a failure only when a user or maintainer asked,
 * so routine worker progress does not flood the trail.
 */
export function isAuditedLifecycleEvent(
  event: string,
  actorKind?: AuditActor["kind"]
): boolean {
  if (AUDITED_LIFECYCLE_EVENTS.has(event)) return true;
  if (AUDITED_MANUAL_EVENTS.has(event)) return actorKind !== "system";
  return false;
}
