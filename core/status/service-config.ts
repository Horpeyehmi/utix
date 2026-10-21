/**
 * Deployment configuration for the service mode, and the public status
 * response built from it (#221).
 *
 * Operators set the mode with environment variables, so a pause or a
 * maintenance notice needs no code change and no database:
 *
 * | Variable              | Value                                         |
 * | --------------------- | --------------------------------------------- |
 * | `UTIX_SERVICE_MODE`    | `normal` (default), `degraded`, `paused`, `maintenance` |
 * | `UTIX_SERVICE_MESSAGE` | Public text, at most 280 characters            |
 * | `UTIX_SERVICE_SINCE`   | Optional ISO-8601 start; a future start schedules the mode |
 * | `UTIX_SERVICE_UNTIL`   | Optional ISO-8601 end; the mode lapses to `normal` after it |
 *
 * A bad value never throws and never publishes the bad value. An unknown mode
 * fails *visible* — it is published as `degraded` rather than silently as
 * `normal`, because the operator was clearly trying to say something was
 * wrong. An unsafe message is dropped and the UI falls back to the generic copy
 * for the mode. Every such problem is emitted as telemetry by the response
 * builder.
 */

import { emitTelemetry } from "@/core/telemetry/telemetry";
import { publishPublicStatusFeed } from "./feed";
import {
  applyServiceMode,
  checkServiceMessage,
  isServiceMode,
  NORMAL_SERVICE,
  toPublicServiceNotice,
  validatePublicServiceNotice,
  type PublicServiceNotice,
  type ServiceModeErrorCode,
  type ServiceModeState
} from "./service-mode";
import type { PublicStatusFeed, TrustedComponent, TrustedStatusState } from "./types";

export const SERVICE_MODE_ENV = {
  mode: "UTIX_SERVICE_MODE",
  message: "UTIX_SERVICE_MESSAGE",
  since: "UTIX_SERVICE_SINCE",
  until: "UTIX_SERVICE_UNTIL"
} as const;

export type ServiceEnv = Readonly<Record<string, string | undefined>>;

export interface ServiceModeConfig {
  readonly state: ServiceModeState;
  /** Problems found in the configuration, as codes. Never the values. */
  readonly issues: readonly ServiceModeErrorCode[];
}

function isIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Reads the service mode from the environment. Never throws. */
export function serviceModeFromEnv(env: ServiceEnv): ServiceModeConfig {
  const issues: ServiceModeErrorCode[] = [];
  const raw = env[SERVICE_MODE_ENV.mode]?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "normal") return { state: NORMAL_SERVICE, issues };

  let mode = raw;
  if (!isServiceMode(mode)) {
    issues.push("invalid_service_mode");
    mode = "degraded";
  }

  const rawMessage = env[SERVICE_MODE_ENV.message];
  let message: string | null = null;
  if (rawMessage !== undefined && rawMessage.trim() !== "") {
    const checked = checkServiceMessage(rawMessage);
    if (checked.ok) message = checked.value;
    else issues.push(checked.code);
  }

  const window = (value: string | undefined): string | null => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (isIso(trimmed)) return trimmed;
    issues.push("invalid_service_window");
    return null;
  };
  const since = window(env[SERVICE_MODE_ENV.since]);
  let until = window(env[SERVICE_MODE_ENV.until]);
  if (since && until && Date.parse(until) <= Date.parse(since)) {
    // An inverted window would make the mode never apply; keep the mode open
    // ended instead, so the operator's intent is still published.
    issues.push("invalid_service_window");
    until = null;
  }

  return { state: { mode: mode as ServiceModeState["mode"], message, since, until, reason: "config:env" }, issues };
}

/**
 * The single published component when no richer trusted state is supplied.
 * The app is one static deployment, so "the tools" is what a user can observe.
 */
export const DEFAULT_STATUS_STATE: TrustedStatusState = {
  components: [{ id: "tools", name: "Stellar tools", status: "operational", visibility: "public" } satisfies TrustedComponent],
  incidents: [],
  maintenance: []
};

export interface StatusResponseBody {
  readonly notice: PublicServiceNotice;
  readonly feed: PublicStatusFeed;
}

export interface StatusResponse {
  readonly status: 200 | 503;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: StatusResponseBody | { readonly error: "status_unavailable" };
}

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // Status must be current: a cached "operational" during an outage is wrong.
  "cache-control": "no-store"
} as const;

/**
 * Builds the `GET /api/status` response. Pure apart from telemetry: the route
 * passes `process.env` and the clock.
 */
export function buildStatusResponse(
  env: ServiceEnv,
  now: number | Date,
  trusted: TrustedStatusState = DEFAULT_STATUS_STATE
): StatusResponse {
  const config = serviceModeFromEnv(env);
  for (const issue of config.issues) {
    emitTelemetry({ op: "status.service_mode_config", actorType: "system", result: "failure", errorCode: issue });
  }

  const notice = validatePublicServiceNotice(toPublicServiceNotice(config.state, now));
  const feed = publishPublicStatusFeed(applyServiceMode(trusted, config.state, now), now);

  if (!notice.ok || !feed.ok) {
    const code = !notice.ok ? notice.code : !feed.ok ? feed.code : undefined;
    emitTelemetry({ op: "status.publish", actorType: "system", result: "failure", errorCode: code });
    return { status: 503, headers: HEADERS, body: { error: "status_unavailable" } };
  }

  return { status: 200, headers: HEADERS, body: { notice: notice.value, feed: feed.value } };
}

/** The notice the UI renders, resolved the same way the API resolves it. */
export function serviceNoticeFromEnv(env: ServiceEnv, now: number | Date): PublicServiceNotice {
  return toPublicServiceNotice(serviceModeFromEnv(env).state, now);
}

/**
 * The notice in force right now, for server components. Reading the clock and
 * the environment here keeps both out of the render body.
 */
export function currentServiceNotice(): PublicServiceNotice {
  return serviceNoticeFromEnv(process.env, Date.now());
}
