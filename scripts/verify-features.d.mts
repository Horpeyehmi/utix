/**
 * Types for scripts/verify-features.mjs so the checker's own test
 * (core/__tests__/verifyFeaturesContract.test.ts) can import it under strict
 * TypeScript. The runtime implementation stays in the .mjs file because
 * `npm run verify:features` executes it directly with node.
 */

export interface ContractCoverageResult {
  slug: string;
  ok: boolean;
  usesHarness: boolean;
  missing: string[];
}

export interface VerifiedSlice {
  slug: string;
  fileCount: number;
  failures: string[];
  contractPending: boolean;
  contractMissing: string[];
  contractUsesHarness: boolean;
  threatBoundaryPending: boolean;
  threatBoundaryMissing: string[];
}

export interface ThreatBoundaryResult {
  slug: string;
  ok: boolean;
  hasSection: boolean;
  missing: string[];
}

export interface SigningCall {
  file: string;
  id: string;
}

export interface VerifySliceOptions {
  /** Directory holding the slice (defaults to <repo>/features). */
  featuresDir?: string;
  /** Slices exempt from the runtime contract rule (migration ledger). */
  contractPending?: Set<string>;
  /** Slices exempt from the threat-boundary documentation rule (migration ledger). */
  threatBoundaryPending?: Set<string>;
}

export const MINIMUM_FILES: number;
export const CONTRACT_STATES: readonly string[];
export const THREAT_BOUNDARY_HEADING: string;
export const THREAT_BOUNDARY_FIELDS: readonly string[];
export const SIGNING_PATTERNS: readonly { id: string; pattern: RegExp }[];

export function loadMigrationLedger(ledgerPath?: string): Set<string>;
export function collectTestSources(sliceDir: string): Promise<Record<string, string>>;
export function evaluateContractCoverage(
  slug: string,
  sources: Record<string, string>
): ContractCoverageResult;
export function checkContractCoverage(
  slug: string,
  sliceDir: string
): Promise<ContractCoverageResult>;
export function verifySlice(slug: string, options?: VerifySliceOptions): Promise<VerifiedSlice>;
export function evaluateThreatBoundaryDoc(slug: string, readme: string | undefined): ThreatBoundaryResult;
export function findSigningCalls(sources: Record<string, string>): SigningCall[];
