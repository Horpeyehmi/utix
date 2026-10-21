#!/usr/bin/env node
/**
 * Verifies every feature slice against the RevyHubX feature contract.
 *
 * The contract is deliberately demanding: a complete slice is a vertical
 * product increment (logic, validation, hooks, UI states, tests, fixtures,
 * request mocks, an end-to-end spec and its own documentation). Meeting it
 * naturally lands above the 20-changed-file threshold without padding.
 *
 * The structural rules below answer "does this slice have a test file?". The
 * runtime contract rule answers the harder question the issue asks: "do its
 * tests actually exercise the loading, error and empty states?". That check
 * reads the slice's `__tests__/` sources and requires the shared harness from
 * `@/core/testing/contract` (see docs/FEATURE_CONTRACT.md).
 *
 * Run: npm run verify:features [-- <slug>]
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REGISTRY_SCHEMA_VERSION } from "./generate-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const featuresDir = path.join(root, "features");
const registryDir = path.join(root, "core", "registry");

export function assertGeneratedRegistryVersion(source, filename, expected = REGISTRY_SCHEMA_VERSION) {
  const actual = Number(source.match(/generatedRegistrySchemaVersion\s*=\s*(\d+)/)?.[1]);
  if (actual !== expected) {
    throw new Error(
      `[registry] ${filename} uses schema v${Number.isFinite(actual) ? actual : "unknown"}; ` +
        `verify:features expects v${expected}. Run npm run registry, then update consumers before bumping the schema.`
    );
  }
}

export async function verifyGeneratedRegistryVersions(directory = registryDir) {
  for (const filename of ["manifests.generated.ts", "panels.generated.ts", "registry.generated.ts"]) {
    assertGeneratedRegistryVersion(await readFile(path.join(directory, filename), "utf8"), filename);
  }
}

export const MINIMUM_FILES = 20;

/**
 * Runtime states every slice's tests must exercise. This is the same list the
 * shared harness exports as `FEATURE_CONTRACT_STATES`.
 */
export const CONTRACT_STATES = ["loading", "error", "empty"];

const CONTRACT_HARNESS_MODULE = /from\s+["']@\/core\/testing(?:\/contract)?["']/;
const CONTRACT_HARNESS_FACTORY = /renderFeatureSlice\s*\(/;

/**
 * Each state is satisfied by calling the matching harness helper — either the
 * named method or the generic `expectState` / `waitForState` form.
 */
const CONTRACT_STATE_MATCHERS = {
  loading: [
    /expectLoadingState\s*\(/,
    /expectState\(\s*["'`]loading["'`]\s*\)/,
    /waitForState\(\s*["'`]loading["'`]\s*\)/
  ],
  error: [
    /expectErrorState\s*\(/,
    /expectState\(\s*["'`]error["'`]\s*\)/,
    /waitForState\(\s*["'`]error["'`]\s*\)/
  ],
  empty: [
    /expectEmptyState\s*\(/,
    /expectState\(\s*["'`]empty["'`]\s*\)/,
    /waitForState\(\s*["'`]empty["'`]\s*\)/
  ]
};

const MIGRATION_LEDGER = path.join(root, "scripts", "feature-contract-migration.json");
const THREAT_BOUNDARY_LEDGER = path.join(root, "scripts", "threat-boundary-migration.json");

/**
 * The read-only threat boundary every slice documents in its README (see
 * docs/FEATURE_CONTRACT.md rule 15). Each field is a bold label followed, on
 * the same line, by a real answer — a `TODO` placeholder does not count.
 */
export const THREAT_BOUNDARY_HEADING = "## Threat boundary";
export const THREAT_BOUNDARY_FIELDS = ["Data sources", "Outbound requests", "Cannot sign or submit"];

/**
 * Calls that would let a slice sign or submit a transaction. Runtime sources
 * must never contain them; fixtures and tests may, because they build signed
 * sample envelopes from fixed seeds.
 */
export const SIGNING_PATTERNS = [
  { id: "secret_keypair", pattern: /\bKeypair\.(?:fromSecret|fromRawEd25519Seed|random)\s*\(/ },
  { id: "sign_call", pattern: /(?<!Math)\.sign(?:Decorated|PayloadDecorated)?\s*\(/ },
  { id: "wallet_sign", pattern: /\bsign(?:Transaction|AuthEntry|Message|Blob)\s*\(/ },
  { id: "horizon_submit", pattern: /\bsubmit(?:Async)?Transaction\s*\(/ },
  { id: "rpc_send", pattern: /\bsendTransaction\b/ }
];

const NON_RUNTIME_DIRS = ["__tests__/", "fixtures/", "e2e/", "msw/"];

/**
 * Slices whose tests still assert the states by hand instead of through the
 * shared harness. They are reported as a warning, not a failure, so existing
 * work keeps landing while the migration is in flight. The ledger is a
 * migration list: it must shrink over time and new slices are never added.
 */
export function loadMigrationLedger(ledgerPath = MIGRATION_LEDGER) {
  if (!existsSync(ledgerPath)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
    const pending = Array.isArray(parsed?.pending) ? parsed.pending : [];
    return new Set(pending.filter((slug) => typeof slug === "string"));
  } catch (error) {
    console.error(`Could not read ${path.relative(root, ledgerPath)}: ${error.message}`);
    process.exit(1);
  }
}

const RULES = [
  { id: "manifest", label: "manifest.ts", check: (f) => f.includes("manifest.ts") },
  { id: "panel", label: "panel.tsx", check: (f) => f.includes("panel.tsx") },
  { id: "types", label: "types.ts", check: (f) => f.includes("types.ts") },
  { id: "schema", label: "schema.ts (input parsing/validation)", check: (f) => f.includes("schema.ts") },
  { id: "copy", label: "copy.ts (all user-facing strings)", check: (f) => f.includes("copy.ts") },
  {
    id: "lib",
    label: "lib/ — at least 2 modules (logic + error mapping)",
    check: (f) => f.filter((x) => x.startsWith("lib/")).length >= 2
  },
  {
    id: "hooks",
    label: "hooks/ — at least 1 hook",
    check: (f) => f.filter((x) => x.startsWith("hooks/")).length >= 1
  },
  {
    id: "components",
    label: "components/ — at least 4 components (panel, form, result, empty/error)",
    check: (f) => f.filter((x) => x.startsWith("components/")).length >= 4
  },
  {
    id: "tests",
    label: "__tests__/ — at least 5 test files",
    check: (f) => f.filter((x) => x.startsWith("__tests__/")).length >= 5
  },
  {
    id: "a11y",
    label: "__tests__/a11y.test.tsx",
    check: (f) => f.includes("__tests__/a11y.test.tsx")
  },
  {
    id: "fixtures",
    label: "fixtures/ — at least 1 deterministic fixture module",
    check: (f) => f.filter((x) => x.startsWith("fixtures/")).length >= 1
  },
  {
    id: "e2e",
    label: "e2e/<slug>.spec.ts",
    check: (f, slug) => f.includes(`e2e/${slug}.spec.ts`)
  },
  { id: "readme", label: "README.md", check: (f) => f.includes("README.md") }
];

const NETWORK_RULE = {
  id: "msw",
  label: "msw/handlers.ts (required for network-backed tools)",
  check: (f) => f.includes("msw/handlers.ts")
};

const NETWORK_CALL = /\b(?:fetch|horizonServer|runHorizonRequest|getHorizonServer)\s*\(/;

async function checkNetworkEpochUsage(sliceDir, files) {
  const sources = await Promise.all(
    files.filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes("__tests__") && !file.includes("fixtures/"))
      .map((file) => readFile(path.join(sliceDir, file), "utf8"))
  );
  if (!sources.some((source) => NETWORK_CALL.test(source))) return true;
  const manifest = await readFile(path.join(sliceDir, "manifest.ts"), "utf8");
  if (/networkEpochIndependent\s*:\s*true/.test(manifest)) return true;
  return sources.some((source) => /\buseNetwork\s*\(/.test(source));
}

async function walk(dir, prefix = "") {
  const out = [];
  const dirents = await readdir(dir, { withFileTypes: true });

  for (const dirent of dirents) {
    const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      out.push(...(await walk(path.join(dir, dirent.name), relative)));
    } else {
      out.push(relative);
    }
  }

  return out;
}

function isTestFile(file) {
  return /\.(test|spec)\.(ts|tsx)$/.test(file);
}

/**
 * Reads every test module under `<sliceDir>/__tests__` so the runtime contract
 * rule can inspect what the suite actually asserts. Exported so the checker's
 * own test can run it against the good/bad fixture slices.
 */
export async function collectTestSources(sliceDir) {
  const testsDir = path.join(sliceDir, "__tests__");
  if (!existsSync(testsDir)) return {};

  const files = (await walk(testsDir)).filter(isTestFile);
  const sources = {};
  for (const file of files) {
    sources[`__tests__/${file}`] = await readFile(path.join(testsDir, file), "utf8");
  }
  return sources;
}

/**
 * Pure contract-coverage evaluation: given a slice's test sources, decide
 * whether they drive every required state through the shared harness.
 */
export function evaluateContractCoverage(slug, sources) {
  const combined = Object.values(sources).join("\n");
  const usesHarness =
    CONTRACT_HARNESS_MODULE.test(combined) && CONTRACT_HARNESS_FACTORY.test(combined);
  const missing = CONTRACT_STATES.filter(
    (state) => !CONTRACT_STATE_MATCHERS[state].some((matcher) => matcher.test(combined))
  );

  return { slug, ok: usesHarness && missing.length === 0, usesHarness, missing };
}

/** Evaluates the runtime contract for a slice directory on disk. */
export async function checkContractCoverage(slug, sliceDir) {
  return evaluateContractCoverage(slug, await collectTestSources(sliceDir));
}

function contractFailure(result) {
  if (!result.usesHarness) {
    return (
      "__tests__/ — runtime contract: use renderFeatureSlice from @/core/testing/contract " +
      "to exercise the loading/error/empty states (having a test file is not enough)"
    );
  }
  return (
    `__tests__/ — runtime contract: missing ${result.missing.join("/")} state assertion(s) ` +
    "(use expectLoadingState/expectErrorState/expectEmptyState)"
  );
}

/**
 * Pure threat-boundary evaluation: given a slice's README, decide whether it
 * documents every field of the read-only threat boundary.
 */
export function evaluateThreatBoundaryDoc(slug, readme) {
  const lines = (readme ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === THREAT_BOUNDARY_HEADING);
  if (start === -1) return { slug, ok: false, hasSection: false, missing: [...THREAT_BOUNDARY_FIELDS] };

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n");

  const missing = THREAT_BOUNDARY_FIELDS.filter((field) => {
    const label = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const answer = section.match(new RegExp(`^\\s*(?:[-*]\\s+)?\\*\\*${label}:\\*\\*[ \\t]*(.*)$`, "m"))?.[1];
    return !answer || answer.trim().length === 0 || /\bTODO\b/.test(answer);
  });

  return { slug, ok: missing.length === 0, hasSection: true, missing };
}

/** Removes comments so prose such as "never calls sendTransaction" is not a match. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * Pure signing scan: given a slice's runtime sources (path → text), list every
 * call that could sign or submit a transaction.
 */
export function findSigningCalls(sources) {
  const hits = [];
  for (const [file, source] of Object.entries(sources)) {
    if (NON_RUNTIME_DIRS.some((dir) => file.startsWith(dir))) continue;
    const code = stripComments(source);
    for (const { id, pattern } of SIGNING_PATTERNS) {
      if (pattern.test(code)) hits.push({ file, id });
    }
  }
  return hits;
}

async function collectRuntimeSources(sliceDir, files) {
  const sources = {};
  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file) || NON_RUNTIME_DIRS.some((dir) => file.startsWith(dir))) continue;
    sources[file] = await readFile(path.join(sliceDir, file), "utf8");
  }
  return sources;
}

async function isNetworkBacked(slug, sliceDir) {
  const manifestPath = path.join(sliceDir, "manifest.ts");
  if (!existsSync(manifestPath)) return false;
  const source = await readFile(manifestPath, "utf8");
  const networks = source.match(/networks:\s*\[([^\]]*)\]/)?.[1] ?? "";
  return networks.trim().length > 0;
}

export async function verifySlice(slug, options = {}) {
  const sliceDir = path.join(options.featuresDir ?? featuresDir, slug);
  const files = await walk(sliceDir);
  const rules = [...RULES];

  if (await isNetworkBacked(slug, sliceDir)) rules.push(NETWORK_RULE);

  const failures = rules
    .filter((rule) => !rule.check(files, slug))
    .map((rule) => rule.label);

  if (!(await checkNetworkEpochUsage(sliceDir, files))) {
    failures.push("network calls must consume the shared NetworkContext epoch through useNetwork()");
  }

  if (files.length < MINIMUM_FILES) {
    failures.push(`at least ${MINIMUM_FILES} files (found ${files.length})`);
  }

  const contract = await checkContractCoverage(slug, sliceDir);
  const pending = (options.contractPending ?? loadMigrationLedger()).has(slug);
  const contractPending = !contract.ok && pending;

  if (!contract.ok && !pending) failures.push(contractFailure(contract));

  // Signing is never grandfathered: a read-only tool has no reason to sign.
  for (const hit of findSigningCalls(await collectRuntimeSources(sliceDir, files))) {
    failures.push(`${hit.file} — read-only boundary: must not sign or submit transactions (${hit.id})`);
  }

  const readmePath = path.join(sliceDir, "README.md");
  const threat = evaluateThreatBoundaryDoc(slug, existsSync(readmePath) ? await readFile(readmePath, "utf8") : "");
  const threatPending = (options.threatBoundaryPending ?? loadMigrationLedger(THREAT_BOUNDARY_LEDGER)).has(slug);
  const threatBoundaryPending = !threat.ok && threatPending;

  if (!threat.ok && !threatPending) {
    failures.push(
      `README.md — "${THREAT_BOUNDARY_HEADING}" section missing ${threat.missing.join(", ")} ` +
        "(see docs/FEATURE_CONTRACT.md rule 15)"
    );
  }

  return {
    slug,
    fileCount: files.length,
    failures,
    contractPending,
    contractMissing: contract.missing,
    contractUsesHarness: contract.usesHarness,
    threatBoundaryPending,
    threatBoundaryMissing: threat.missing
  };
}

async function main() {
  await verifyGeneratedRegistryVersions();
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

  if (!existsSync(featuresDir)) {
    console.error("features/ does not exist");
    process.exit(1);
  }

  const dirents = await readdir(featuresDir, { withFileTypes: true });
  const slugs = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
    .map((d) => d.name)
    .filter((slug) => requested.length === 0 || requested.includes(slug))
    .sort();

  if (!slugs.length) {
    console.log("No feature slices found.");
    return;
  }

  const results = [];
  for (const slug of slugs) results.push(await verifySlice(slug));

  const failed = results.filter((result) => result.failures.length);
  const pending = results.filter((result) => result.contractPending);

  for (const result of results) {
    const mark = result.failures.length ? "FAIL" : " OK ";
    console.log(`[${mark}] ${result.slug.padEnd(32)} ${String(result.fileCount).padStart(3)} files`);
    for (const failure of result.failures) console.log(`         missing: ${failure}`);
    // Only spell the migration warning out for a targeted run; the summary
    // below carries the count for a full sweep so CI output stays readable.
    if (result.contractPending && requested.length > 0) {
      const states = result.contractMissing.join(", ");
      console.log(
        `         warning: runtime contract not asserted (${states}) — pending migration, ` +
          `see scripts/feature-contract-migration.json`
      );
    }
    if (result.threatBoundaryPending && requested.length > 0) {
      console.log(
        `         warning: threat boundary not documented (${result.threatBoundaryMissing.join(", ")}) — ` +
          `pending migration, see scripts/threat-boundary-migration.json`
      );
    }
  }

  const threatPending = results.filter((result) => result.threatBoundaryPending);

  console.log(
    `\n${results.length} slice(s) checked, ${failed.length} failing, ` +
      `${pending.length} pending contract migration, ` +
      `${threatPending.length} pending threat-boundary docs, ` +
      `${results.reduce((sum, r) => sum + r.fileCount, 0)} files total`
  );

  if (failed.length) process.exit(1);
}

if (process.argv[1] && (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href || fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase())) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
