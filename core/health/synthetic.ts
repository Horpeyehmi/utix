
/**
 * Synthetic monitoring for the critical end-to-end journey (#269)
 *
 * The critical journey (tests/e2e/critical-journey.spec.ts) is the operation
 * browser: load an account's operation history newest-first, then follow the
 * last paging token to the next older page. The e2e spec proves the UI against
 * mocked Horizon; this probe proves the same Horizon contract against the live
 * network on a schedule, so an upstream break is seen before a user reports it.
 *
 * Steps, each against the configured Horizon:
 *   1. `horizon.root`             `GET /` — reachable, right network passphrase,
 *                                 ingestion lag (`core_latest_ledger` −
 *                                 `history_latest_ledger`) within tolerance.
 *   2. `operations.discover`      `GET /operations?order=desc&limit=1` — finds a
 *                                 currently active account, so the probe needs
 *                                 no fixture that a testnet reset would delete.
 *   3. `account.operations`       `GET /accounts/{id}/operations?order=desc&limit=20`
 *                                 — the journey's first page.
 *   4. `account.operations.older` the same with `cursor=<last paging_token>`,
 *                                 only when page one was full — the "Load more" step.
 *
 * Transient failures (HTTP 429, 5xx, transport errors, timeouts) are retried
 * with exponential backoff, honouring `Retry-After`. Contract failures (wrong
 * passphrase, malformed body, broken pagination) are not retried: retrying
 * cannot fix them. Running the probe is an operator action gated on
 * `admin:health`.
 *
 * Complexity: O(steps × maxAttempts) requests; O(page size) time and space per
 * step to validate one page.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import type { HealthStatus } from "@/core/health/types";
import { HORIZON_URLS, NETWORK_PASSPHRASES } from "@/core/network/config";
import type { StellarNetwork } from "@/core/network/types";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";

export type SyntheticStepName =
  | "horizon.root"
  | "operations.discover"
  | "account.operations"
  | "account.operations.older";

export type SyntheticErrorCode =
  | "rate_limited"
  | "server_error"
  | "transport"
  | "timeout"
  | "http_status"
  | "malformed_payload"
  | "network_mismatch"
  | "no_activity"
  | "pagination_broken";

export interface SyntheticStepResult {
  readonly step: SyntheticStepName;
  readonly ok: boolean;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly errorCode?: SyntheticErrorCode;
}

export interface SyntheticReport {
  readonly network: StellarNetwork;
  readonly status: HealthStatus;
  readonly correlationId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly steps: readonly SyntheticStepResult[];
  /** `core_latest_ledger − history_latest_ledger` from `GET /`. */
  readonly ingestLagLedgers?: number;
}

export interface SyntheticMonitorOptions {
  readonly network: StellarNetwork;
  /** Defaults to the configured Horizon for `network`. */
  readonly horizonUrl?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Per-request timeout. */
  readonly timeoutMs?: number;
  /** Attempts per step, including the first. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  /** Ceiling for any single backoff, including a server's `Retry-After`. */
  readonly maxDelayMs?: number;
  /** A run slower than this is `degraded`. */
  readonly latencyBudgetMs?: number;
  /** Ingestion lag above this is `degraded`. */
  readonly maxIngestLagLedgers?: number;
  /** Injectable clock for deterministic tests of `startedAt`/`durationMs`. */
  readonly clock?: () => number;
}

/** Mirrors the operation browser's page size, so page two is exercised exactly as users reach it. */
export const SYNTHETIC_PAGE_SIZE = 20;

const DEFAULTS = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  latencyBudgetMs: 5_000,
  maxIngestLagLedgers: 5
} as const;

const PUBLIC_KEY = /^G[A-Z2-7]{55}$/;
const PAGING_TOKEN = /^\d+$/;

interface Attempt {
  readonly result: Result<unknown, SyntheticErrorCode>;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

/**
 * `Retry-After` is delay-seconds or an HTTP-date (RFC 9110 §10.2.3). All three
 * HTTP-date forms (IMF-fixdate, RFC 850, asctime) open with a day name, which
 * keeps `Date.parse` from reading a value like `-1` as a year.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function records(body: unknown): Record<string, unknown>[] | null {
  const list = (body as { _embedded?: { records?: unknown } } | null)?._embedded?.records;
  return Array.isArray(list) && list.every((item) => item !== null && typeof item === "object")
    ? (list as Record<string, unknown>[])
    : null;
}

/**
 * Paging tokens must be numeric, unique and strictly descending, and every one
 * must sit below `cursor` when one was sent. O(n) over the page.
 */
function isDescendingPage(page: Record<string, unknown>[], cursor?: string): boolean {
  let previous = cursor === undefined ? undefined : BigInt(cursor);
  for (const record of page) {
    const token = record.paging_token;
    if (typeof token !== "string" || !PAGING_TOKEN.test(token)) return false;
    const value = BigInt(token);
    if (previous !== undefined && value >= previous) return false;
    previous = value;
  }
  return true;
}

/**
 * A step that never ran (because an earlier step failed) is recorded as a
 * skipped failure with `errorCode: "skipped"` so the report shows the whole
 * journey, not just the prefix that executed. `attempts: 0` distinguishes it
 * from a real failed attempt.
 */
function skippedStep(name: SyntheticStepName): SyntheticStepResult {
  return { step: name, ok: false, attempts: 0, latencyMs: 0, errorCode: "skipped" };
}

export async function runSyntheticMonitor(
  auth: AuthContext,
  options: SyntheticMonitorOptions
): Promise<Result<SyntheticReport, "synthetic_unauthorized">> {
  const correlationId = newCorrelationId();
  if (!hasPermission(auth.role, "admin:health")) {
    emitTelemetry({
      op: "synthetic.journey",
      actorType: "system",
      result: "failure",
      correlationId,
      errorCode: "synthetic_unauthorized",
      payload: { network: options.network, role: auth.role }
    });
    return err("synthetic_unauthorized");
  }

  // `??` per field, so an explicit `undefined` keeps the default instead of
  // turning the timeout into an immediate abort.
  const settings = {
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
    baseDelayMs: options.baseDelayMs ?? DEFAULTS.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
    latencyBudgetMs: options.latencyBudgetMs ?? DEFAULTS.latencyBudgetMs,
    maxIngestLagLedgers: options.maxIngestLagLedgers ?? DEFAULTS.maxIngestLagLedgers
  };
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? (() => Date.now());
  const base = `${(options.horizonUrl ?? HORIZON_URLS[options.network]).replace(/\/+$/, "")}/`;
  const steps: SyntheticStepResult[] = [];
  const startedAt = now();

  async function attempt(url: string): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (response.status === 429) {
        return {
          result: err("rate_limited"),
          retryable: true,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now())
        };
      }
      if (response.status >= 500) return { result: err("server_error"), retryable: true };
      if (!response.ok) return { result: err("http_status"), retryable: false };
      try {
        return { result: ok(await response.json()), retryable: false };
      } catch {
        return { result: err("malformed_payload"), retryable: false };
      }
    } catch {
      return { result: err(controller.signal.aborted ? "timeout" : "transport"), retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetches with retries, validates, and records the step. Null means the journey stops. */
  async function step<T>(
    name: SyntheticStepName,
    path: string,
    query: Record<string, string>,
    validate: (body: unknown) => Result<T, SyntheticErrorCode>
  ): Promise<T | null> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const started = now();
    let attempts = 0;
    let outcome: Attempt;
    for (;;) {
      attempts += 1;
      outcome = await attempt(url.toString());
      if (!outcome.retryable || attempts >= settings.maxAttempts) break;
      const backoff = settings.baseDelayMs * 2 ** (attempts - 1);
      await sleep(Math.min(Math.max(backoff, outcome.retryAfterMs ?? 0), settings.maxDelayMs));
    }

    const validated = outcome.result.ok ? validate(outcome.result.value) : outcome.result;
    steps.push({
      step: name,
      ok: validated.ok,
      attempts,
      latencyMs: now() - started,
      ...(validated.ok ? {} : { errorCode: validated.code })
    });
    return validated.ok ? validated.value : null;
  }

  const expectedPassphrase = NETWORK_PASSPHRASES[options.network];
  const root = await step("horizon.root", "", {}, (body) => {
    const { network_passphrase, core_latest_ledger, history_latest_ledger } = (body ?? {}) as Record<string, unknown>;
    if (typeof network_passphrase !== "string" || !Number.isSafeInteger(core_latest_ledger) || !Number.isSafeInteger(history_latest_ledger)) {
      return err("malformed_payload");
    }
    if (network_passphrase !== expectedPassphrase) return err("network_mismatch");
    return ok({ ingestLag: (core_latest_ledger as number) - (history_latest_ledger as number) });
  });

  const accountId =
    root &&
    (await step("operations.discover", "operations", { order: "desc", limit: "1" }, (body) => {
      const page = records(body);
      if (!page) return err("malformed_payload");
      if (page.length === 0) return err("no_activity");
      const source = page[0].source_account;
      return typeof source === "string" && PUBLIC_KEY.test(source) ? ok(source) : err("malformed_payload");
    }));
  if (!root) steps.push(skippedStep("operations.discover"));

  const operationsPath = accountId ? `accounts/${encodeURIComponent(accountId)}/operations` : "";
  const query = { order: "desc", limit: String(SYNTHETIC_PAGE_SIZE) };
  const firstPage =
    accountId &&
    (await step("account.operations", operationsPath, query, (body) => {
      const page = records(body);
      if (!page) return err("malformed_payload");
      // The account was just discovered from its own operation, so an empty page is broken.
      if (page.length === 0 || !isDescendingPage(page)) return err("pagination_broken");
      return ok(page);
    }));
  if (!accountId) steps.push(skippedStep("account.operations"));

  if (firstPage && firstPage.length === SYNTHETIC_PAGE_SIZE) {
    const cursor = firstPage[firstPage.length - 1].paging_token as string;
    await step("account.operations.older", operationsPath, { ...query, cursor }, (body) => {
      const page = records(body);
      if (!page) return err("malformed_payload");
      return isDescendingPage(page, cursor) ? ok(page) : err("pagination_broken");
    });
  }
  if (firstPage && firstPage.length < SYNTHETIC_PAGE_SIZE) steps.push(skippedStep("account.operations.older"));

  const durationMs = now() - startedAt;
  const failed = steps.find((result) => !result.ok);
  const ingestLagLedgers = root?.ingestLag;
  const status: HealthStatus = failed
    ? "unhealthy"
    : steps.some((result) => result.attempts > 1) ||
        durationMs > settings.latencyBudgetMs ||
        (ingestLagLedgers ?? 0) > settings.maxIngestLagLedgers
      ? "degraded"
      : "healthy";

  emitTelemetry({
    op: "synthetic.journey",
    actorType: "system",
    result: failed ? "failure" : "success",
    latencyMs: durationMs,
    correlationId,
    errorCode: failed?.errorCode,
    payload: { network: options.network, status, steps: steps.map(({ step: name, ok: passed, attempts }) => ({ name, passed, attempts })) }
  });

  return ok({
    network: options.network,
    status,
    correlationId,
    startedAt: new Date(clock()).toISOString(),
    durationMs,
    steps,
    ...(ingestLagLedgers === undefined ? {} : { ingestLagLedgers })
  });
}
