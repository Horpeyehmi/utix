/**
 * User-facing explanations for rejected operations (#190).
 *
 * Low-level failures reach the edge of the app in several shapes: a `Result`
 * error code, a domain `InvariantViolation`, an `UnauthorizedError`, or an
 * unexpected thrown value. This module maps every one of them onto a single
 * `RejectionExplanation` so each client renders the same stable reason code,
 * the same plain-language message and the same recovery hints.
 *
 * Rules:
 *
 * - **reason codes are stable.** Clients switch on `reasonCode`; a code is
 *   never renamed or removed, a new one is added instead;
 * - **explanations are user-safe.** Only the fixed copy below is returned.
 *   Raw error messages, entity ids, limits and stack traces never leave this
 *   module, so a low-level message cannot leak through a rejection;
 * - **unknown input falls back.** Anything that is not recognised becomes
 *   `unexpected_failure`, so a caller always receives an explanation.
 */

import { ERROR_CODES } from "@/core/errors/error-codes";
import { UnauthorizedError } from "@/core/auth/middleware";

export const REJECTION_SCHEMA_VERSION = 1;

export type RejectionCategory =
  | "validation"
  | "policy"
  | "permission"
  | "stale_state"
  | "concurrency"
  | "operational"
  | "unexpected";

export interface RejectionReason {
  readonly category: RejectionCategory;
  readonly title: string;
  readonly message: string;
  /** Ordered, actionable steps. Never empty. */
  readonly recovery: readonly string[];
  readonly retryable: boolean;
  /** HTTP status an API response should use. */
  readonly status: number;
}

export const REJECTION_REASONS = {
  // ── Validation ────────────────────────────────────────────────────────────
  invalid_input: {
    category: "validation",
    title: "Check your input",
    message: "Some of the information you entered is not valid.",
    recovery: ["Review the highlighted fields.", "Correct them and submit again."],
    retryable: false,
    status: 400
  },
  invalid_address: {
    category: "validation",
    title: "Invalid address",
    message: "The Stellar address is not valid.",
    recovery: ["Use a public key that starts with G and is 56 characters long.", "Never paste a secret key."],
    retryable: false,
    status: 400
  },
  invalid_amount: {
    category: "validation",
    title: "Invalid amount",
    message: "The amount is not valid.",
    recovery: ["Enter a positive whole or decimal number with at most 7 decimal places."],
    retryable: false,
    status: 400
  },
  missing_field: {
    category: "validation",
    title: "Missing information",
    message: "A required field was left out.",
    recovery: ["Fill in every required field.", "Submit again."],
    retryable: false,
    status: 400
  },
  unsupported_version: {
    category: "validation",
    title: "Unsupported version",
    message: "The requested format version is not supported.",
    recovery: ["Update the client to the current version.", "Request the current schema version."],
    retryable: false,
    status: 400
  },
  invalid_request_key: {
    category: "validation",
    title: "Invalid request key",
    message: "The request key is missing or malformed.",
    recovery: ["Send a unique request key of 8 to 128 letters, digits or . _ : - characters."],
    retryable: false,
    status: 400
  },
  request_key_reused: {
    category: "validation",
    title: "Request key already used",
    message: "That request key was already used for a different request.",
    recovery: ["Generate a new request key for each distinct request."],
    retryable: false,
    status: 409
  },

  // ── Policy ────────────────────────────────────────────────────────────────
  capacity_reached: {
    category: "policy",
    title: "Sold out",
    message: "The event has reached its maximum capacity.",
    recovery: ["Check whether more tickets are released later.", "Contact the organizer about a waitlist."],
    retryable: false,
    status: 409
  },
  ticket_locked: {
    category: "policy",
    title: "Ticket is locked",
    message: "This ticket is locked and cannot be used for this action right now.",
    recovery: ["Wait for the lock to clear.", "Contact support if you believe the lock is a mistake."],
    retryable: false,
    status: 409
  },
  account_restricted: {
    category: "policy",
    title: "Account restricted",
    message: "An account involved in this action is restricted.",
    recovery: ["Use a different account.", "Contact support to review the restriction."],
    retryable: false,
    status: 403
  },
  outside_validity_window: {
    category: "policy",
    title: "Outside the valid time window",
    message: "This action is only allowed within the ticket's validity window.",
    recovery: ["Check the start and end time on the ticket.", "Try again within that window."],
    retryable: false,
    status: 409
  },
  event_cancelled: {
    category: "policy",
    title: "Event cancelled",
    message: "This event has been cancelled.",
    recovery: ["Contact the organizer about refunds."],
    retryable: false,
    status: 409
  },
  rate_limited: {
    category: "policy",
    title: "Too many requests",
    message: "You have made too many requests in a short time.",
    recovery: ["Wait a little while.", "Try again at a lower pace."],
    retryable: true,
    status: 429
  },

  // ── Permission ────────────────────────────────────────────────────────────
  unauthenticated: {
    category: "permission",
    title: "Sign in required",
    message: "You need to sign in to do this.",
    recovery: ["Sign in again.", "Retry the action."],
    retryable: false,
    status: 401
  },
  permission_denied: {
    category: "permission",
    title: "Not allowed",
    message: "You do not have permission to do this.",
    recovery: ["Ask an administrator for access.", "Switch to an account that has access."],
    retryable: false,
    status: 403
  },
  not_owner: {
    category: "permission",
    title: "Not the owner",
    message: "Only the current owner of this item can do this.",
    recovery: ["Switch to the wallet that owns the item.", "Check who currently owns it."],
    retryable: false,
    status: 403
  },

  // ── Stale state ───────────────────────────────────────────────────────────
  not_found: {
    category: "stale_state",
    title: "Not found",
    message: "The item you asked for could not be found.",
    recovery: ["Refresh the page and check the id.", "It may have been moved or removed."],
    retryable: false,
    status: 404
  },
  already_redeemed: {
    category: "stale_state",
    title: "Already redeemed",
    message: "This ticket has already been redeemed.",
    recovery: ["Each ticket can be redeemed once.", "Refresh to see the current ticket status."],
    retryable: false,
    status: 409
  },
  already_transferred: {
    category: "stale_state",
    title: "Already transferred",
    message: "This ticket has already been transferred.",
    recovery: ["Refresh to see the current owner."],
    retryable: false,
    status: 409
  },
  invalid_state_transition: {
    category: "stale_state",
    title: "Action no longer possible",
    message: "The item is in a state that does not allow this action.",
    recovery: ["Refresh to see the current status.", "Start again from the latest state."],
    retryable: false,
    status: 409
  },
  duplicate_request: {
    category: "stale_state",
    title: "Already processed",
    message: "This request was already processed.",
    recovery: ["Refresh to see the result of the earlier request.", "Do not submit it again."],
    retryable: false,
    status: 409
  },
  request_in_progress: {
    category: "stale_state",
    title: "Still in progress",
    message: "An earlier identical request is still being processed.",
    recovery: ["Wait a moment.", "Refresh to see the result before trying again."],
    retryable: true,
    status: 409
  },
  request_expired: {
    category: "stale_state",
    title: "Request expired",
    message: "This request is too old to be replayed.",
    recovery: ["Start the action again with a new request."],
    retryable: false,
    status: 410
  },

  // ── Concurrency ───────────────────────────────────────────────────────────
  duplicate_submission: {
    category: "concurrency",
    title: "Already processed",
    message: "This submission was already processed.",
    recovery: ["Use the result from the original submission.", "Do not submit again."],
    retryable: false,
    status: 409
  },
  stale_version: {
    category: "concurrency",
    title: "Resource updated",
    message: "The resource has been updated since this operation was initiated.",
    recovery: ["Refresh the resource to get the latest version.", "Try the operation again."],
    retryable: true,
    status: 409
  },

  // ── Operational ───────────────────────────────────────────────────────────
  dead_letter_queue_full: {
    category: "operational",
    title: "System overloaded",
    message: "The system is unable to process jobs at the moment.",
    recovery: ["Try again in a moment.", "The system will recover automatically."],
    retryable: true,
    status: 503
  },
  job_scheduling_error: {
    category: "operational",
    title: "Job scheduling failed",
    message: "Failed to schedule the background job.",
    recovery: ["Try again later.", "Contact support if this persists."],
    retryable: true,
    status: 503
  },
  metadata_retention_expired: {
    category: "stale_state",
    title: "Metadata expired",
    message: "The operational metadata for this request has expired.",
    recovery: ["Submit a new request.", "The system can no longer recover this operation."],
    retryable: false,
    status: 410
  },
  operation_recovery_failed: {
    category: "operational",
    title: "Recovery failed",
    message: "Failed to recover the operation.",
    recovery: ["Contact support with the operation ID.", "Manual investigation may be required."],
    retryable: false,
    status: 500
  },

  // ── Unexpected ────────────────────────────────────────────────────────────
  network_unavailable: {
    category: "unexpected",
    title: "Network problem",
    message: "We could not reach the Stellar network.",
    recovery: ["Check your connection.", "Try again in a moment."],
    retryable: true,
    status: 502
  },
  timed_out: {
    category: "unexpected",
    title: "Took too long",
    message: "The operation timed out.",
    recovery: ["Try again.", "Check the item's status before repeating a payment."],
    retryable: true,
    status: 504
  },
  unexpected_failure: {
    category: "unexpected",
    title: "Something went wrong",
    message: "An unexpected error occurred.",
    recovery: ["Try again later.", "If it keeps happening, contact support and quote the reference."],
    retryable: true,
    status: 500
  }
} as const satisfies Record<string, RejectionReason>;

export type RejectionReasonCode = keyof typeof REJECTION_REASONS;

/** The explanation object every client receives. */
export interface RejectionExplanation extends RejectionReason {
  readonly schemaVersion: typeof REJECTION_SCHEMA_VERSION;
  readonly reasonCode: RejectionReasonCode;
  /** Quote this to support. Present only when the caller supplied one. */
  readonly reference?: string;
}

export interface ExplainOptions {
  readonly correlationId?: string;
}

/**
 * Low-level codes (stable error codes and `Result` codes from idempotency,
 * quota, export and replay) and the reason each one is explained as.
 */
export const REJECTION_SOURCE_CODES: Readonly<Record<string, RejectionReasonCode>> = {
  INVALID_INPUT: "invalid_input",
  INVALID_ADDRESS: "invalid_address",
  INVALID_AMOUNT: "invalid_amount",
  MISSING_REQUIRED_FIELD: "missing_field",
  UNAUTHORIZED: "unauthenticated",
  TOKEN_EXPIRED: "unauthenticated",
  INVALID_SIGNATURE: "unauthenticated",
  FORBIDDEN: "permission_denied",
  NOT_OWNER: "not_owner",
  NOT_FOUND: "not_found",
  TICKET_NOT_FOUND: "not_found",
  EVENT_NOT_FOUND: "not_found",
  ALREADY_REDEEMED: "already_redeemed",
  ALREADY_TRANSFERRED: "already_transferred",
  EVENT_CANCELLED: "event_cancelled",
  RATE_LIMITED: "rate_limited",
  DUPLICATE_SUBMISSION: "duplicate_submission",
  STALE_VERSION: "stale_version",
  DEAD_LETTER_QUEUE_FULL: "dead_letter_queue_full",
  JOB_SCHEDULING_ERROR: "job_scheduling_error",
  METADATA_RETENTION_EXPIRED: "metadata_retention_expired",
  OPERATION_RECOVERY_FAILED: "operation_recovery_failed",
  INTERNAL_ERROR: "unexpected_failure",
  NETWORK_ERROR: "network_unavailable",
  TIMEOUT: "timed_out",

  idempotency_key_missing: "invalid_request_key",
  idempotency_key_invalid: "invalid_request_key",
  idempotency_key_conflict: "request_key_reused",
  idempotency_key_expired: "request_expired",
  idempotency_in_flight: "request_in_progress",
  idempotency_not_found: "not_found",

  quota_exceeded: "rate_limited",
  quota_override_denied: "permission_denied",
  quota_diagnostics_denied: "permission_denied",

  export_denied: "permission_denied",
  field_authorization_denied: "permission_denied",
  schema_unsupported: "unsupported_version",

  replay_unauthorized: "permission_denied",
  invalid_options: "invalid_input",
  replay_in_progress: "request_in_progress",
  version_active: "invalid_state_transition",
  source_unavailable: "network_unavailable"
};

/** Domain invariants (`core/invariants`) and the reason each one is explained as. */
export const REJECTION_INVARIANTS: Readonly<Record<string, RejectionReasonCode>> = {
  "INV-01": "capacity_reached",
  // INV-02 also reports a missing ticket; the copy covers both without leaking ids.
  "INV-02": "not_owner",
  "INV-03": "invalid_state_transition",
  "INV-04": "invalid_state_transition",
  "INV-05": "ticket_locked",
  "INV-06": "invalid_amount",
  "INV-07": "invalid_amount",
  "INV-08": "outside_validity_window",
  "INV-09": "duplicate_request",
  "INV-10": "capacity_reached",
  "INV-11": "account_restricted"
};

/** Builds the explanation for an already-known reason code. */
export function explainReason(reasonCode: RejectionReasonCode, options: ExplainOptions = {}): RejectionExplanation {
  const reason: RejectionReason = REJECTION_REASONS[reasonCode];
  return {
    schemaVersion: REJECTION_SCHEMA_VERSION,
    reasonCode,
    ...reason,
    ...(options.correlationId ? { reference: options.correlationId } : {})
  };
}

function lookup(table: Readonly<Record<string, RejectionReasonCode>>, key: unknown): RejectionReasonCode | undefined {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function reasonFor(input: unknown): RejectionReasonCode {
  if (input instanceof UnauthorizedError) return "permission_denied";

  if (typeof input === "string") {
    return lookup(REJECTION_SOURCE_CODES, input) ?? "unexpected_failure";
  }

  if (input && typeof input === "object") {
    const candidate = input as { ok?: unknown; code?: unknown; invariantId?: unknown };
    const fromInvariant = lookup(REJECTION_INVARIANTS, candidate.invariantId);
    if (fromInvariant) return fromInvariant;
    // A failed `Result`, or any object that carries a stable code.
    if (candidate.ok !== true) {
      const fromCode = lookup(REJECTION_SOURCE_CODES, candidate.code);
      if (fromCode) return fromCode;
      // Domain mutations fail with the violation itself as the code.
      if (candidate.ok === false && candidate.code && typeof candidate.code === "object") {
        return reasonFor(candidate.code);
      }
    }
  }

  return "unexpected_failure";
}

/**
 * Maps any rejection onto its explanation. Never throws and never returns the
 * input's own message: unrecognised input becomes `unexpected_failure`.
 */
export function explainRejection(input: unknown, options: ExplainOptions = {}): RejectionExplanation {
  return explainReason(reasonFor(input), options);
}

/** Plain-text rendering shared by clients that do not build their own UI. */
export function renderRejection(explanation: RejectionExplanation): string {
  const lines = [`${explanation.title}: ${explanation.message}`];
  if (explanation.recovery.length > 0) {
    lines.push("What you can do:", ...explanation.recovery.map((step) => `- ${step}`));
  }
  if (explanation.reference) lines.push(`Reference: ${explanation.reference}`);
  return lines.join("\n");
}

/** Every known stable code must resolve to a reason; used by tests and docs. */
export function unmappedErrorCodes(): string[] {
  return Object.keys(ERROR_CODES).filter((code) => !lookup(REJECTION_SOURCE_CODES, code));
}
