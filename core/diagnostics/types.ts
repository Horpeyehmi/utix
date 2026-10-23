/**
 * Contributor Diagnostics Types (#275)
 *
 * Types for validating developer environments, dependency trees,
 * registry drift, and boundary isolation.
 *
 * Operational notes:
 * - Diagnostics are read-only; no check may mutate the workspace or registry.
 * - `DiagnosticsOptions.actor` gates which checks may run. Callers without the
 *   `diagnostics:run` permission receive an authorization failure report rather
 *   than partial results.
 * - Transient failures (e.g. missing lockfile during an in-progress install)
 *   should be reported as `warn` with a retry hint so callers can re-run the
 *   suite. Rollback is not applicable: the suite holds no state.
 * - Field additions are backwards compatible; existing consumers keying on
 *   `status`, `summary`, and `overallStatus` are unaffected.
 */

export type DiagnosticStatus = "pass" | "warn" | "fail";

export type DiagnosticCategory =
  | "node_runtime"
  | "environment"
  | "dependencies"
  | "registry"
  | "boundaries";

/** Permission required for the actor to execute diagnostics. */
export const DIAGNOSTICS_RUN_PERMISSION = "diagnostics:run" as const;

/** Retry guidance attached to transient results. */
export interface DiagnosticRetryHint {
  readonly retryable: boolean;
  readonly afterMs?: number;
  readonly reason?: "transient_io" | "install_in_progress" | "lock_contention";
}

export interface DiagnosticCheckResult {
  readonly id: string;
  readonly category: DiagnosticCategory;
  readonly name: string;
  readonly status: DiagnosticStatus;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly remediation?: string; // Actionable copy-paste shell command or guidance
  readonly retry?: DiagnosticRetryHint;
}

export type DiagnosticsAuthorizationOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "missing_actor" | "missing_permission" };

export interface ContributorDiagnosticsReport {
  readonly evaluatedAt: string;
  readonly overallStatus: "healthy" | "degraded" | "failing";
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly warnings: number;
    readonly failures: number;
  };
  readonly checks: readonly DiagnosticCheckResult[];
  readonly remediationSteps: readonly string[];
  /** Present when the run was refused by authorization; `checks` is then empty. */
  readonly authorization?: DiagnosticsAuthorizationOutcome;
}

export interface DiagnosticsOptions {
  readonly projectRoot?: string;
  readonly now?: number | Date;
  readonly strict?: boolean; // Treat warnings as failures
  readonly actor?: { kind: string; id: string; permissions?: readonly string[] };
}
