/**
 * Contributor Diagnostics Runner (#275)
 *
 * Orchestrates environment and dependency validation checks, aggregates
 * results, and produces human-readable and structured JSON reports.
 */

import path from "node:path";
import {
  checkDependencies,
  checkEnvironmentVariables,
  checkFeatureBoundaries,
  checkNodeRuntime,
  checkRegistrySync
} from "./checks.ts";
import type {
  ContributorDiagnosticsReport,
  DiagnosticCheckResult,
  DiagnosticsOptions
} from "./types.ts";

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 150;

type CheckFn = () => Promise<DiagnosticCheckResult>;

/**
 * Runs a single check with bounded retries. Retries only when the thrown
 * error looks transient (timeouts, EAGAIN/EBUSY, EACCES is NOT retried since
 * it is an authorization failure and must surface immediately).
 */
async function runWithRetry(
  fn: CheckFn,
  maxAttempts: number,
  retryDelayMs: number
): Promise<DiagnosticCheckResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const transient = code === "EAGAIN" || code === "EBUSY" || code === "ETIMEDOUT";
      if (!transient || attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  throw lastError;
}

export async function runContributorDiagnostics(
  options: DiagnosticsOptions = {}
): Promise<ContributorDiagnosticsReport> {
  const projectRoot = options.projectRoot ?? path.resolve(process.cwd());
  const evaluatedAt = options.now instanceof Date
    ? options.now.toISOString()
    : typeof options.now === "number"
      ? new Date(options.now).toISOString()
      : new Date().toISOString();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // Run all diagnostic checks concurrently with isolated error boundaries
  const checks: DiagnosticCheckResult[] = await Promise.all([
    runWithRetry(checkNodeRuntime, maxAttempts, retryDelayMs).catch((err) => ({
      id: "node-version",
      category: "node_runtime" as const,
      name: "Node.js Engine Version",
      status: "fail" as const,
      message: `Check threw unexpected error: ${err instanceof Error ? err.message : String(err)}`
    })),
    runWithRetry(checkEnvironmentVariables, maxAttempts, retryDelayMs).catch((err) => ({
      id: "environment-config",
      category: "environment" as const,
      name: "Environment Configuration & Sanitization",
      status: "fail" as const,
      message: `Check threw unexpected error: ${err instanceof Error ? err.message : String(err)}`
    })),
    runWithRetry(() => checkDependencies(projectRoot), maxAttempts, retryDelayMs).catch((err) => ({
      id: "dependencies-tree",
      category: "dependencies" as const,
      name: "Dependencies & Node Modules",
      status: "fail" as const,
      message: `Check threw unexpected error: ${err instanceof Error ? err.message : String(err)}`
    })),
    runWithRetry(() => checkRegistrySync(projectRoot), maxAttempts, retryDelayMs).catch((err) => ({
      id: "registry-sync",
      category: "registry" as const,
      name: "Feature Registry Synchronization",
      status: "fail" as const,
      message: `Check threw unexpected error: ${err instanceof Error ? err.message : String(err)}`
    })),
    runWithRetry(() => checkFeatureBoundaries(projectRoot), maxAttempts, retryDelayMs).catch((err) => ({
      id: "feature-boundaries",
      category: "boundaries" as const,
      name: "Feature Boundary Isolation",
      status: "warn" as const,
      message: `Check threw unexpected error: ${err instanceof Error ? err.message : String(err)}`
    }))
  ]);

  let passed = 0;
  let warnings = 0;
  let failures = 0;
  const remediationSteps: string[] = [];

  for (const check of checks) {
    if (check.status === "pass") {
      passed += 1;
    } else if (check.status === "warn") {
      warnings += 1;
      if (check.remediation) remediationSteps.push(check.remediation);
    } else if (check.status === "fail") {
      failures += 1;
      if (check.remediation) remediationSteps.push(check.remediation);
    }
  }

  const overallStatus =
    failures > 0 || (options.strict && warnings > 0)
      ? "failing"
      : warnings > 0
        ? "degraded"
        : "healthy";

  return {
    evaluatedAt,
    overallStatus,
    summary: {
      total: checks.length,
      passed,
      warnings,
      failures
    },
    checks,
    remediationSteps: Array.from(new Set(remediationSteps))
  };
}

/** Formats a diagnostics report into a clean, human-readable terminal string. */
export function formatDiagnosticsReport(report: ContributorDiagnosticsReport): string {
  const lines: string[] = [];
  lines.push("=================================================");
  lines.push("       UTIX CONTRIBUTOR DIAGNOSTICS REPORT       ");
  lines.push("=================================================");
  lines.push(`Evaluated at: ${report.evaluatedAt}`);
  lines.push(`Status: ${report.overallStatus.toUpperCase()}`);
  lines.push(
    `Summary: ${report.summary.passed}/${report.summary.total} passed, ` +
    `${report.summary.warnings} warning(s), ${report.summary.failures} failure(s)\n`
  );

  for (const check of report.checks) {
    const badge =
      check.status === "pass"
        ? "[PASS]"
        : check.status === "warn"
          ? "[WARN]"
          : "[FAIL]";
    lines.push(`${badge} ${check.name} (${check.category})`);
    lines.push(`       ${check.message}`);
    if (check.remediation) {
      lines.push(`       -> Remediation: ${check.remediation}`);
    }
  }

  lines.push("=================================================");
  if (report.overallStatus === "healthy") {
    lines.push("SUCCESS: All contributor environment and dependency checks passed.");
  } else if (report.overallStatus === "degraded") {
    lines.push("WARNING: Environment usable with non-critical warnings. See remediation steps above.");
  } else {
    lines.push("ACTION REQUIRED: Fix the failures above to ensure build and test integrity.");
  }
  lines.push("=================================================");

  return lines.join("\n");
}
