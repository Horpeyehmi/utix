/**
 * Contributor Diagnostics Types (#275)
 *
 * Types for validating developer environments, dependency trees,
 * registry drift, and boundary isolation.
 */

export type DiagnosticStatus = "pass" | "warn" | "fail";

export type DiagnosticCategory =
  | "node_runtime"
  | "environment"
  | "dependencies"
  | "registry"
  | "boundaries";

export interface DiagnosticCheckResult {
  readonly id: string;
  readonly category: DiagnosticCategory;
  readonly name: string;
  readonly status: DiagnosticStatus;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly remediation?: string; // Actionable copy-paste shell command or guidance
}

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
}

export interface DiagnosticsOptions {
  readonly projectRoot?: string;
  readonly now?: number | Date;
  readonly strict?: boolean; // Treat warnings as failures
  readonly actor?: { kind: string; id: string; permissions?: readonly string[] };
}
