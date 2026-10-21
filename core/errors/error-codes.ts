/**
 * Stable error codes with documented remediation hints (#267).
 *
 * Every error code is a stable string that clients can switch on. Each
 * carries a human-readable message and a remediation hint describing
 * what the user should do next. Codes are versioned — never rename or
 * remove a code; add a new one instead.
 */

export interface ErrorDefinition {
  code: string;
  message: string;
  /** What the user should do to resolve this error. */
  remediation: string;
  /** HTTP status code for API responses. */
  status: number;
  /** Whether the operation can be safely retried. */
  retryable: boolean;
}

export const ERROR_CODES = {
  // ── Validation (400) ──────────────────────────────────────────────────────
  INVALID_INPUT: {
    code: 'INVALID_INPUT',
    message: 'The provided input is invalid',
    remediation: 'Check the input format and try again. See the API docs for expected formats.',
    status: 400,
    retryable: false,
  },
  INVALID_ADDRESS: {
    code: 'INVALID_ADDRESS',
    message: 'The Stellar address is invalid',
    remediation: 'Ensure the address starts with G (public key) or S (secret key) and is 56 characters.',
    status: 400,
    retryable: false,
  },
  INVALID_AMOUNT: {
    code: 'INVALID_AMOUNT',
    message: 'The amount is invalid',
    remediation: 'Enter a positive number with at most 7 decimal places.',
    status: 400,
    retryable: false,
  },
  MISSING_REQUIRED_FIELD: {
    code: 'MISSING_REQUIRED_FIELD',
    message: 'A required field is missing',
    remediation: 'Include all required fields. Check the API docs for the expected schema.',
    status: 400,
    retryable: false,
  },

  // ── Authentication (401) ──────────────────────────────────────────────────
  UNAUTHORIZED: {
    code: 'UNAUTHORIZED',
    message: 'Authentication required',
    remediation: 'Log in or provide a valid authentication token.',
    status: 401,
    retryable: false,
  },
  TOKEN_EXPIRED: {
    code: 'TOKEN_EXPIRED',
    message: 'The authentication token has expired',
    remediation: 'Refresh your token or log in again.',
    status: 401,
    retryable: false,
  },
  INVALID_SIGNATURE: {
    code: 'INVALID_SIGNATURE',
    message: 'The signature is invalid',
    remediation: 'Verify you signed the correct message with the correct key.',
    status: 401,
    retryable: false,
  },

  // ── Authorization (403) ───────────────────────────────────────────────────
  FORBIDDEN: {
    code: 'FORBIDDEN',
    message: 'You do not have permission to perform this action',
    remediation: 'Contact the resource owner or administrator for access.',
    status: 403,
    retryable: false,
  },
  NOT_OWNER: {
    code: 'NOT_OWNER',
    message: 'Only the resource owner can perform this action',
    remediation: 'Switch to the wallet that owns this resource.',
    status: 403,
    retryable: false,
  },

  // ── Not Found (404) ───────────────────────────────────────────────────────
  NOT_FOUND: {
    code: 'NOT_FOUND',
    message: 'The requested resource was not found',
    remediation: 'Verify the ID or address and try again.',
    status: 404,
    retryable: false,
  },
  TICKET_NOT_FOUND: {
    code: 'TICKET_NOT_FOUND',
    message: 'Ticket not found',
    remediation: 'Verify the ticket ID. The ticket may have been transferred or redeemed.',
    status: 404,
    retryable: false,
  },
  EVENT_NOT_FOUND: {
    code: 'EVENT_NOT_FOUND',
    message: 'Event not found',
    remediation: 'Verify the event ID. The event may have been cancelled.',
    status: 404,
    retryable: false,
  },

  // ── Conflict (409) ────────────────────────────────────────────────────────
  ALREADY_REDEEMED: {
    code: 'ALREADY_REDEEMED',
    message: 'This ticket has already been redeemed',
    remediation: 'Each ticket can only be redeemed once. Check the ticket status.',
    status: 409,
    retryable: false,
  },
  ALREADY_TRANSFERRED: {
    code: 'ALREADY_TRANSFERRED',
    message: 'This ticket has already been transferred',
    remediation: 'The ticket is no longer in your wallet. Check the current owner.',
    status: 409,
    retryable: false,
  },
  EVENT_CANCELLED: {
    code: 'EVENT_CANCELLED',
    message: 'This event has been cancelled',
    remediation: 'The event is no longer active. Contact the organizer for refunds.',
    status: 409,
    retryable: false,
  },

  // ── Rate Limit (429) ──────────────────────────────────────────────────────
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    message: 'Too many requests',
    remediation: 'Wait and try again. Reduce request frequency if this persists.',
    status: 429,
    retryable: true,
  },

  // ── Concurrency (409) ────────────────────────────────────────────────────
  DUPLICATE_SUBMISSION: {
    code: 'DUPLICATE_SUBMISSION',
    message: 'This submission was already processed',
    remediation: 'Use the idempotency key from your original request to retrieve the result.',
    status: 409,
    retryable: false,
  },
  STALE_VERSION: {
    code: 'STALE_VERSION',
    message: 'The resource has been updated since this operation was initiated',
    remediation: 'Refresh your data and try again. Ensure you are using the latest version.',
    status: 409,
    retryable: false,
  },

  // ── Operational (503) ────────────────────────────────────────────────────
  DEAD_LETTER_QUEUE_FULL: {
    code: 'DEAD_LETTER_QUEUE_FULL',
    message: 'The system is unable to process this job at the moment',
    remediation: 'Retry after some time. The system will process pending jobs before accepting new ones.',
    status: 503,
    retryable: true,
  },
  JOB_SCHEDULING_ERROR: {
    code: 'JOB_SCHEDULING_ERROR',
    message: 'Failed to schedule the background job',
    remediation: 'Try again later. Contact support if this persists.',
    status: 503,
    retryable: true,
  },
  METADATA_RETENTION_EXPIRED: {
    code: 'METADATA_RETENTION_EXPIRED',
    message: 'The operational metadata for this request has expired',
    remediation: 'The request is no longer recoverable. Submit a new request.',
    status: 410,
    retryable: false,
  },
  OPERATION_RECOVERY_FAILED: {
    code: 'OPERATION_RECOVERY_FAILED',
    message: 'Failed to recover the operation',
    remediation: 'Contact support with the operation ID to manually investigate.',
    status: 500,
    retryable: false,
  },

  // ── Server Errors (500+) ──────────────────────────────────────────────────
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    remediation: 'Try again later. If the problem persists, contact support with the request ID.',
    status: 500,
    retryable: true,
  },
  NETWORK_ERROR: {
    code: 'NETWORK_ERROR',
    message: 'Network error connecting to Stellar',
    remediation: 'Check your connection and try again. The Stellar network may be experiencing issues.',
    status: 502,
    retryable: true,
  },
  TIMEOUT: {
    code: 'TIMEOUT',
    message: 'The operation timed out',
    remediation: 'Try again. Increase the timeout if the operation is expected to take longer.',
    status: 504,
    retryable: true,
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function getErrorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_CODES[code];
}

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_CODES[code].retryable;
}
