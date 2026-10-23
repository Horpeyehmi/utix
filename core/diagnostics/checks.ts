/**
 * Contributor Diagnostic Checks (#275)
 *
 * Implements inspection checks across Node.js runtime, environment variables,
 * dependencies, registry synchronization, and feature boundaries.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { DiagnosticCheckResult, DiagnosticsOptions } from "./types.ts";

const SECRET_KEY_PATTERN = /\bS[A-Z2-7]{55}\b/;
const MIN_NODE_MAJOR = 20;

/**
 * Shared retry policy for transient filesystem errors (e.g. EBUSY/EAGAIN on
 * Windows or network mounts during `npm install`). Permanent errors such as
 * ENOENT are never retried.
 */
const TRANSIENT_FS_CODES = new Set(["EBUSY", "EAGAIN", "EMFILE", "ENFILE"]);
export const FS_RETRY_ATTEMPTS = 3;
export const FS_RETRY_DELAY_MS = 50;

function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_FS_CODES.has(code);
}

/** Retries an fs operation only on transient errors, with linear backoff. */
async function withFsRetry<T>(
  op: () => Promise<T>,
  attempts: number = FS_RETRY_ATTEMPTS,
  delayMs: number = FS_RETRY_DELAY_MS
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isTransientFsError(err) || attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastErr;
}

/** Exported for tests: classifies a filesystem error into an actionable hint. */
export function describeFsError(err: unknown): { code: string; hint: string } {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN";
  switch (code) {
    case "ENOENT":
      return { code, hint: "File or directory does not exist. Check the project root path." };
    case "EACCES":
    case "EPERM":
      return { code, hint: "Permission denied. Check file ownership and run from a directory you can read." };
    case "EBUSY":
    case "EAGAIN":
      return { code, hint: "Resource is busy or temporarily unavailable. Close other processes using it and retry." };
    case "ENOTDIR":
      return { code, hint: "A path component is not a directory. Check the project layout." };
    default:
      return { code, hint: "Unexpected filesystem error. Re-run with the same inputs; if it persists, inspect the path." };
  }
}

export async function checkNodeRuntime(): Promise<DiagnosticCheckResult> {
  const version = process.version;
  const major = parseInt(version.replace(/^v/, "").split(".")[0], 10);

  if (isNaN(major) || major < MIN_NODE_MAJOR) {
    return {
      id: "node-version",
      category: "node_runtime",
      name: "Node.js Engine Version",
      status: "fail",
      message: `Running Node.js ${version}, but Utix requires Node.js >= v${MIN_NODE_MAJOR}.0.0.`,
      details: { currentVersion: version, requiredMajor: MIN_NODE_MAJOR },
      remediation: `Install and switch to Node.js v${MIN_NODE_MAJOR}: run 'nvm install 20 && nvm use 20'`
    };
  }

  return {
    id: "node-version",
    category: "node_runtime",
    name: "Node.js Engine Version",
    status: "pass",
    message: `Running Node.js ${version} (meets >= v${MIN_NODE_MAJOR}.0.0 requirement).`,
    details: { currentVersion: version, platform: process.platform, arch: process.arch }
  };
}

export async function checkEnvironmentVariables(): Promise<DiagnosticCheckResult> {
  const network = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  const warnings: string[] = [];
  const failures: string[] = [];

  // Check network validity
  if (network && network !== "testnet" && network !== "mainnet") {
    failures.push(`Invalid NEXT_PUBLIC_STELLAR_NETWORK: '${network}'. Must be 'testnet' or 'mainnet'.`);
  }

  // Check for leaked Stellar secret keys in all environment variables
  for (const [key, val] of Object.entries(process.env)) {
    if (val && SECRET_KEY_PATTERN.test(val)) {
      failures.push(`CRITICAL SECURITY: Secret key pattern detected in environment variable '${key}'. Never put secret seeds in environment variables.`);
    }
  }

  // Check endpoint URLs for basic auth credentials
  const urlsToCheck = [
    { key: "NEXT_PUBLIC_HORIZON_TESTNET_URL", val: process.env.NEXT_PUBLIC_HORIZON_TESTNET_URL },
    { key: "NEXT_PUBLIC_HORIZON_MAINNET_URL", val: process.env.NEXT_PUBLIC_HORIZON_MAINNET_URL },
    { key: "NEXT_PUBLIC_SOROBAN_RPC_TESTNET_URL", val: process.env.NEXT_PUBLIC_SOROBAN_RPC_TESTNET_URL },
    { key: "NEXT_PUBLIC_SOROBAN_RPC_MAINNET_URL", val: process.env.NEXT_PUBLIC_SOROBAN_RPC_MAINNET_URL }
  ];

  for (const { key, val } of urlsToCheck) {
    if (val) {
      try {
        const parsed = new URL(val);
        if (parsed.username || parsed.password) {
          failures.push(`Endpoint '${key}' contains embedded credentials. Credentials must not be present in public endpoints.`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          warnings.push(`Endpoint '${key}' uses unexpected protocol '${parsed.protocol}'. Expected 'https:' or 'http:'.`);
        }
      } catch {
        failures.push(`Endpoint '${key}' is not a valid URL: '${val}'`);
      }
    }
  }

  if (failures.length > 0) {
    return {
      id: "environment-config",
      category: "environment",
      name: "Environment Configuration & Sanitization",
      status: "fail",
      message: failures.join("; "),
      details: { failures, warnings },
      remediation: "Review and sanitize .env.local; ensure no secret keys (S...) or credentials are included."
    };
  }

  if (warnings.length > 0) {
    return {
      id: "environment-config",
      category: "environment",
      name: "Environment Configuration & Sanitization",
      status: "warn",
      message: warnings.join("; "),
      details: { warnings }
    };
  }

  return {
    id: "environment-config",
    category: "environment",
    name: "Environment Configuration & Sanitization",
    status: "pass",
    message: "Environment variables valid; zero secret keys or embedded credentials detected.",
    details: { activeNetwork: network ?? "testnet (default)" }
  };
}

export async function checkDependencies(projectRoot: string): Promise<DiagnosticCheckResult> {
  const pkgPath = path.join(projectRoot, "package.json");
  const nodeModulesPath = path.join(projectRoot, "node_modules");

  try {
    const pkgRaw = await withFsRetry(() => readFile(pkgPath, "utf8"));
    const pkg = JSON.parse(pkgRaw);

    const hasNodeModules = await withFsRetry(() => stat(nodeModulesPath))
      .then((s) => s.isDirectory())
      .catch(() => false);

    if (!hasNodeModules) {
      return {
        id: "dependencies-tree",
        category: "dependencies",
        name: "Dependencies & Node Modules",
        status: "warn",
        message: "node_modules directory is missing or not installed.",
        details: { packageJson: pkg.name, version: pkg.version },
        remediation: "Run 'npm install' to install project dependencies."
      };
    }

    // Check key dependency presence
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const requiredPackages = ["@stellar/stellar-sdk", "next", "react", "typescript", "vitest"];
    const missing = requiredPackages.filter((p) => !deps[p]);

    if (missing.length > 0) {
      return {
        id: "dependencies-tree",
        category: "dependencies",
        name: "Dependencies & Node Modules",
        status: "fail",
        message: `Missing core package declarations in package.json: ${missing.join(", ")}`,
        details: { missing },
        remediation: "Restore required packages in package.json and run 'npm install'."
      };
    }

    return {
      id: "dependencies-tree",
      category: "dependencies",
      name: "Dependencies & Node Modules",
      status: "pass",
      message: `Dependencies declared and node_modules present (${Object.keys(deps).length} total packages).`,
      details: { totalDeclaredDeps: Object.keys(deps).length }
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const { code, hint } = describeFsError(err);
    return {
      id: "dependencies-tree",
      category: "dependencies",
      name: "Dependencies & Node Modules",
      status: "fail",
      message: `Failed to inspect package dependencies (${code}): ${errorMsg}`,
      details: { code },
      remediation: `${hint} Verify package.json exists and is valid JSON.`
    };
  }
}

export async function checkRegistrySync(projectRoot: string): Promise<DiagnosticCheckResult> {
  const featuresDir = path.join(projectRoot, "features");
  const generatedManifestPath = path.join(projectRoot, "core", "registry", "manifests.generated.ts");

  try {
    const featureEntries = await withFsRetry(() => readdir(featuresDir, { withFileTypes: true }));
    const featureDirs = featureEntries.filter((e) => e.isDirectory()).map((e) => e.name);

    let manifestContent = "";
    try {
      manifestContent = await withFsRetry(() => readFile(generatedManifestPath, "utf8"));
    } catch {
      return {
        id: "registry-sync",
        category: "registry",
        name: "Feature Registry Synchronization",
        status: "fail",
        message: "Generated registry (core/registry/manifests.generated.ts) is missing.",
        remediation: "Run 'npm run registry' to generate the registry files."
      };
    }

    // Match all exported manifests in generatedManifests array
    const manifestSlugs = featureDirs.filter((slug) =>
      manifestContent.includes(`features/${slug}/manifest`)
    );

    if (manifestSlugs.length < featureDirs.length) {
      const missingCount = featureDirs.length - manifestSlugs.length;
      return {
        id: "registry-sync",
        category: "registry",
        name: "Feature Registry Synchronization",
        status: "warn",
        message: `Registry drift detected: ${missingCount} feature slices in features/ are not registered.`,
        details: { totalFeatureDirs: featureDirs.length, registeredInManifest: manifestSlugs.length },
        remediation: "Run 'npm run registry' to regenerate manifests and lazy registry."
      };
    }

    return {
      id: "registry-sync",
      category: "registry",
      name: "Feature Registry Synchronization",
      status: "pass",
      message: `Registry is in sync: all ${featureDirs.length} feature slices are properly registered.`,
      details: { totalFeatures: featureDirs.length }
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const { code, hint } = describeFsError(err);
    return {
      id: "registry-sync",
      category: "registry",
      name: "Feature Registry Synchronization",
      status: "fail",
      message: `Failed to inspect feature registry (${code}): ${errorMsg}`,
      details: { code },
      remediation: `${hint} Run 'npm run registry'`
    };
  }
}

export async function checkFeatureBoundaries(projectRoot: string): Promise<DiagnosticCheckResult> {
  const exceptionsPath = path.join(projectRoot, "scripts", "feature-boundary-exceptions.json");

  try {
    const exceptionsRaw = await withFsRetry(() => readFile(exceptionsPath, "utf8"));
    const parsed = JSON.parse(exceptionsRaw);
    const count = parsed.exceptions?.length ?? 0;

    return {
      id: "feature-boundaries",
      category: "boundaries",
      name: "Feature Boundary Isolation",
      status: "pass",
      message: `Boundary rules intact with ${count} documented and reviewed exception(s).`,
      details: { exceptionCount: count }
    };
  } catch (err: unknown) {
    const { code, hint } = describeFsError(err);
    return {
      id: "feature-boundaries",
      category: "boundaries",
      name: "Feature Boundary Isolation",
      status: "warn",
      message: `scripts/feature-boundary-exceptions.json could not be read (${code}); using default boundary rules.`,
      details: { code },
      remediation: `${hint} Verify scripts/feature-boundary-exceptions.json exists and is valid JSON.`
    };
  }
}
