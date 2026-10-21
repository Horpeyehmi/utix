/**
 * Safe public service mode: degraded, paused or maintenance (#221).
 *
 * The public status feed (#184) derives health from components, incidents and
 * maintenance windows. This module adds the operator's switch on top of it: one
 * app-wide mode with a short public message, set by a maintainer, audited, and
 * published through the same "trusted in, public out" split the feed uses.
 *
 * - `ServiceModeState` is trusted. It may carry an internal `reason` and the
 *   id of whoever set it. `toPublicServiceNotice` copies only the public
 *   fields, so neither can reach a user.
 * - The public message is operator-written text, so it is checked before it is
 *   accepted: a Stellar secret, bearer token, credential URL, `key=value`
 *   secret, private network address or stack frame is refused outright rather
 *   than scrubbed, because a half-redacted message is still a leak.
 * - A mode can carry `since` and `until`. Outside that window the effective
 *   mode is `normal`, from the clock alone, so a forgotten maintenance mode
 *   recovers by itself. `createServiceModeStore().expire()` records that
 *   recovery in the audit trail; the `status.expire_service_mode` worker job
 *   runs it in the background.
 * - Every change is audited before it is applied. If the trail rejects the
 *   event, the mode does not change.
 */

import { recordAudit, type AuditActor, type AuditEvent, type AuditInput } from "@/core/audit/audit";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, type ActorType } from "@/core/telemetry/telemetry";
import type { WorkerFramework } from "@/core/workers/queue";
import { worseComponentStatus } from "./feed";
import type { ComponentStatus, TrustedStatusState } from "./types";

export const SERVICE_MODES = ["normal", "degraded", "paused", "maintenance"] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export const PUBLIC_SERVICE_NOTICE_SCHEMA_VERSION = "1.0.0";

/** Background job that records a mode's automatic recovery. */
export const SERVICE_MODE_EXPIRY_OP = "status.expire_service_mode";

/** Long enough for a sentence and an ETA, short enough for a banner. */
export const SERVICE_MESSAGE_MAX_LENGTH = 280;

export type ServiceMessageErrorCode = "service_message_required" | "service_message_too_long" | "unsafe_service_message";

export type ServiceModeErrorCode =
  | ServiceMessageErrorCode
  | "invalid_service_mode"
  | "invalid_service_window"
  | "invalid_service_reason"
  | "service_mode_forbidden"
  | "service_mode_audit_rejected";

export interface ServiceModeState {
  readonly mode: ServiceMode;
  /** Public. Shown to every user as written. */
  readonly message: string | null;
  /** ISO-8601 instants bounding the mode; `null` means unbounded. */
  readonly since: string | null;
  readonly until: string | null;
  /** Internal-only: why the mode was set, e.g. `incident:inc-42`. Never published. */
  readonly reason?: string;
  /** Internal-only: who set it. Never published. */
  readonly changedBy?: string;
}

export interface PublicServiceNotice {
  readonly schemaVersion: typeof PUBLIC_SERVICE_NOTICE_SCHEMA_VERSION;
  readonly mode: ServiceMode;
  readonly message: string | null;
  readonly since: string | null;
  readonly until: string | null;
}

export const NORMAL_SERVICE: ServiceModeState = { mode: "normal", message: null, since: null, until: null };

/** How each mode raises the published components in the status feed. */
export const SERVICE_MODE_COMPONENT_STATUS: Record<Exclude<ServiceMode, "normal">, ComponentStatus> = {
  degraded: "degraded",
  maintenance: "under_maintenance",
  // Paused means the tools are deliberately unavailable, which is what a user
  // experiences as an outage.
  paused: "major_outage"
};

export function isServiceMode(value: unknown): value is ServiceMode {
  return typeof value === "string" && (SERVICE_MODES as readonly string[]).includes(value);
}

const UNSAFE_MESSAGE_PATTERNS: readonly RegExp[] = [
  // Stellar secret seed or muxed secret.
  /[SM][A-Z2-7]{55}/,
  /\bBearer\s+\S+/i,
  // Credentials inside a URL: scheme://user:pass@host.
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  // key=value or key: value for anything that names a secret.
  /\b(?:secret|token|password|passphrase|api[_-]?key|private[_-]?key|seed)\b\s*[:=]/i,
  // Private, loopback and link-local addresses: an internal host is diagnostics.
  /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  /\b169\.254\.\d{1,3}\.\d{1,3}\b/,
  /\blocalhost\b/i,
  // A stack frame such as "at run (worker.ts:42" or "worker.ts:42:7".
  /\b[\w./-]+\.(?:ts|tsx|js|mjs|cjs):\d+/
];

/** Validates operator-written public text. Refuses rather than scrubs. */
export function checkServiceMessage(value: unknown): Result<string, ServiceMessageErrorCode> {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return err("service_message_required");
  if (text.length > SERVICE_MESSAGE_MAX_LENGTH) return err("service_message_too_long");
  if (UNSAFE_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))) return err("unsafe_service_message");
  return ok(text);
}

function isIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** The mode in force at `nowMs`: `normal` outside the `since`–`until` window. */
export function effectiveServiceMode(state: ServiceModeState, nowMs: number): ServiceModeState {
  if (state.mode === "normal") return state;
  if (state.since && nowMs < Date.parse(state.since)) return NORMAL_SERVICE;
  if (state.until && nowMs >= Date.parse(state.until)) return NORMAL_SERVICE;
  return state;
}

/** The published notice for `now`. Copies only the public fields. */
export function toPublicServiceNotice(state: ServiceModeState, now: number | Date): PublicServiceNotice {
  const effective = effectiveServiceMode(state, typeof now === "number" ? now : now.getTime());
  return {
    schemaVersion: PUBLIC_SERVICE_NOTICE_SCHEMA_VERSION,
    mode: effective.mode,
    message: effective.mode === "normal" ? null : effective.message,
    since: effective.mode === "normal" ? null : effective.since,
    until: effective.mode === "normal" ? null : effective.until
  };
}

/**
 * The notice schema: exactly these keys, known values, ISO instants, and a
 * message that passes the same safety check an operator's input does.
 */
export function validatePublicServiceNotice(value: unknown): Result<PublicServiceNotice, "invalid_service_notice", string> {
  const invalid = (path: string) => err("invalid_service_notice" as const, path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("$");
  const fields = value as Record<string, unknown>;
  const keys = ["schemaVersion", "mode", "message", "since", "until"];
  if (Object.keys(fields).length !== keys.length || !keys.every((key) => key in fields)) return invalid("$");
  if (fields.schemaVersion !== PUBLIC_SERVICE_NOTICE_SCHEMA_VERSION) return invalid("schemaVersion");
  if (!isServiceMode(fields.mode)) return invalid("mode");
  if (fields.message !== null && !checkServiceMessage(fields.message).ok) return invalid("message");
  if (fields.since !== null && !isIso(fields.since)) return invalid("since");
  if (fields.until !== null && !isIso(fields.until)) return invalid("until");
  return ok(value as PublicServiceNotice);
}

/**
 * Projects the effective mode onto trusted status state, so the feed's
 * per-component and overall status agree with the notice. Components are only
 * raised, never lowered, and internal components are left alone.
 */
export function applyServiceMode(
  state: TrustedStatusState,
  serviceMode: ServiceModeState,
  now: number | Date
): TrustedStatusState {
  const effective = effectiveServiceMode(serviceMode, typeof now === "number" ? now : now.getTime());
  if (effective.mode === "normal") return state;
  const floor = SERVICE_MODE_COMPONENT_STATUS[effective.mode];
  return {
    ...state,
    components: state.components.map((component) =>
      component.visibility === "public"
        ? { ...component, status: worseComponentStatus(component.status, floor) }
        : component
    )
  };
}

export interface ServiceModeChangeRequest {
  readonly mode: unknown;
  readonly message?: unknown;
  /** ISO-8601; defaults to now. A future `since` schedules the mode. */
  readonly since?: unknown;
  /** ISO-8601; must be after `since`. Omit for an open-ended mode. */
  readonly until?: unknown;
  /** Internal reason code, e.g. `incident:inc-42`. Audited, never published. */
  readonly reason: string;
}

const REASON_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

/**
 * Validates a change request into the next state. Pure: authorization, audit
 * and telemetry happen in the store.
 */
export function parseServiceModeChange(
  request: ServiceModeChangeRequest,
  nowMs: number
): Result<ServiceModeState, Exclude<ServiceModeErrorCode, "service_mode_forbidden" | "service_mode_audit_rejected">> {
  if (!isServiceMode(request.mode)) return err("invalid_service_mode");
  if (typeof request.reason !== "string" || !REASON_PATTERN.test(request.reason)) return err("invalid_service_reason");
  if (request.mode === "normal") return ok({ ...NORMAL_SERVICE, reason: request.reason });

  const message = checkServiceMessage(request.message);
  if (!message.ok) return message;

  if (request.since !== undefined && !isIso(request.since)) return err("invalid_service_window");
  if (request.until !== undefined && !isIso(request.until)) return err("invalid_service_window");
  const since = (request.since as string | undefined) ?? new Date(nowMs).toISOString();
  const until = (request.until as string | undefined) ?? null;
  if (until && (Date.parse(until) <= Date.parse(since) || Date.parse(until) <= nowMs)) {
    return err("invalid_service_window");
  }

  return ok({ mode: request.mode, message: message.value, since, until, reason: request.reason });
}

export interface ServiceModeStore {
  /** The stored state, which may be outside its window. */
  readonly stored: () => ServiceModeState;
  /** The state in force at `now`. */
  readonly current: (now?: number) => ServiceModeState;
  readonly notice: (now?: number) => PublicServiceNotice;
  /** Maintainers and the system may change the mode; users may not. */
  readonly change: (actor: AuditActor, request: ServiceModeChangeRequest) => Result<ServiceModeState, ServiceModeErrorCode>;
  /**
   * Returns the store to `normal` if the stored mode's `until` has passed, and
   * records that recovery. `true` when it did.
   */
  readonly expire: (now?: number) => boolean;
}

export interface ServiceModeStoreOptions {
  readonly initial?: ServiceModeState;
  readonly now?: () => number;
  /**
   * Test seam: substitutes the audit recorder. When it returns `undefined` the
   * store behaves as if the audit trail rejected the event and does not apply
   * the change.
   */
  readonly record?: (input: AuditInput) => AuditEvent | undefined;
}

function telemetryActor(actor: AuditActor): ActorType {
  return actor.kind === "system" ? "system" : "user";
}

export function createServiceModeStore(options: ServiceModeStoreOptions = {}): ServiceModeStore {
  const record = options.record ?? recordAudit;
  const clock = options.now ?? Date.now;
  let state: ServiceModeState = options.initial ?? NORMAL_SERVICE;

  interface ServiceModeAudit {
    readonly action: "service_mode.changed" | "service_mode.expired";
    readonly actor: AuditActor;
    readonly next: { readonly mode: unknown; readonly until?: unknown };
    readonly outcome: "allowed" | "denied";
    readonly reason: string | undefined;
    readonly errorCode?: ServiceModeErrorCode;
  }

  function audit({ action, actor, next, outcome, reason, errorCode }: ServiceModeAudit): AuditEvent | undefined {
    return record({
      action,
      actor,
      scope: "maintainer",
      target: { kind: "service_mode", id: "app" },
      reason: reason && REASON_PATTERN.test(reason) ? reason : undefined,
      outcome,
      before: { mode: state.mode, until: state.until },
      after: { mode: typeof next.mode === "string" ? next.mode : null, until: typeof next.until === "string" ? next.until : null },
      errorCode
    });
  }

  function report(op: string, actor: AuditActor, from: ServiceMode, to: unknown, errorCode?: ServiceModeErrorCode): void {
    emitTelemetry({
      op,
      actorType: telemetryActor(actor),
      result: errorCode ? "failure" : "success",
      errorCode,
      payload: { from, to: isServiceMode(to) ? to : "invalid" }
    });
  }

  const store: ServiceModeStore = {
    stored: () => state,
    current: (now = clock()) => effectiveServiceMode(state, now),
    notice: (now = clock()) => toPublicServiceNotice(state, now),

    change(actor, request) {
      const deny = (code: ServiceModeErrorCode) => {
        audit({ action: "service_mode.changed", actor, next: request, outcome: "denied", reason: request.reason, errorCode: code });
        report("status.service_mode_change", actor, state.mode, request.mode, code);
        return err(code);
      };

      if (actor.kind === "user") return deny("service_mode_forbidden");

      const parsed = parseServiceModeChange(request, clock());
      if (!parsed.ok) return deny(parsed.code);

      const next: ServiceModeState = {
        ...parsed.value,
        changedBy: actor.kind === "maintainer" ? actor.id : (actor.id ?? "system")
      };

      // Audit-first: nothing changes unless the event is on the trail.
      if (!audit({ action: "service_mode.changed", actor, next, outcome: "allowed", reason: request.reason })) {
        report("status.service_mode_change", actor, state.mode, next.mode, "service_mode_audit_rejected");
        return err("service_mode_audit_rejected");
      }

      report("status.service_mode_change", actor, state.mode, next.mode);
      state = next;
      return ok(state);
    },

    expire(now = clock()) {
      if (state.mode === "normal" || !state.until || now < Date.parse(state.until)) return false;
      const actor: AuditActor = { kind: "system", id: SERVICE_MODE_EXPIRY_OP };
      const reason = "service_mode:until_reached";
      if (!audit({ action: "service_mode.expired", actor, next: NORMAL_SERVICE, outcome: "allowed", reason })) return false;
      report("status.service_mode_expired", actor, state.mode, "normal");
      state = { ...NORMAL_SERVICE, reason, changedBy: SERVICE_MODE_EXPIRY_OP };
      return true;
    }
  };

  return store;
}

/**
 * Registers the expiry job on a worker framework. Schedule it at (or just
 * after) a mode's `until`; running it early or twice is a harmless no-op.
 */
export function registerServiceModeJobs(framework: WorkerFramework, store: ServiceModeStore): WorkerFramework {
  framework.register(
    SERVICE_MODE_EXPIRY_OP,
    (_params, context) => {
      context.signal.throwIfAborted();
      store.expire();
    },
    { maxAttempts: 3 }
  );
  return framework;
}
