import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createCaptureSink,
  resetTelemetrySink,
  setTelemetrySink,
  type TelemetryCaptureSink
} from "@/core/telemetry/telemetry";
import { validatePublicStatusFeed } from "../feed";
import {
  buildStatusResponse,
  currentServiceNotice,
  serviceModeFromEnv,
  serviceNoticeFromEnv,
  type StatusResponseBody
} from "../service-config";
import { validatePublicServiceNotice } from "../service-mode";
import { GET } from "@/app/api/status/route";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const secret = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).secret();

describe("serviceModeFromEnv", () => {
  it("is normal when nothing is configured", () => {
    expect(serviceModeFromEnv({})).toEqual({ state: expect.objectContaining({ mode: "normal" }), issues: [] });
    expect(serviceModeFromEnv({ UTIX_SERVICE_MODE: " Normal " }).state.mode).toBe("normal");
  });

  it("reads a complete configuration", () => {
    const { state, issues } = serviceModeFromEnv({
      UTIX_SERVICE_MODE: "MAINTENANCE",
      UTIX_SERVICE_MESSAGE: "Upgrading the indexer.",
      UTIX_SERVICE_SINCE: iso(NOW),
      UTIX_SERVICE_UNTIL: iso(NOW + HOUR)
    });
    expect(issues).toEqual([]);
    expect(state).toMatchObject({ mode: "maintenance", message: "Upgrading the indexer.", since: iso(NOW), until: iso(NOW + HOUR) });
  });

  it("fails visible on an unknown mode instead of silently reporting normal", () => {
    expect(serviceModeFromEnv({ UTIX_SERVICE_MODE: "pasued" })).toMatchObject({
      state: { mode: "degraded" },
      issues: ["invalid_service_mode"]
    });
  });

  it("drops an unsafe message but keeps the mode", () => {
    const { state, issues } = serviceModeFromEnv({ UTIX_SERVICE_MODE: "paused", UTIX_SERVICE_MESSAGE: `key ${secret}` });
    expect(state).toMatchObject({ mode: "paused", message: null });
    expect(issues).toEqual(["unsafe_service_message"]);
  });

  it("ignores an unparseable or inverted window rather than never applying the mode", () => {
    expect(serviceModeFromEnv({ UTIX_SERVICE_MODE: "paused", UTIX_SERVICE_UNTIL: "friday" })).toMatchObject({
      state: { mode: "paused", until: null },
      issues: ["invalid_service_window"]
    });
    expect(
      serviceModeFromEnv({ UTIX_SERVICE_MODE: "paused", UTIX_SERVICE_SINCE: iso(NOW + HOUR), UTIX_SERVICE_UNTIL: iso(NOW) })
    ).toMatchObject({ state: { since: iso(NOW + HOUR), until: null }, issues: ["invalid_service_window"] });
  });

  it("resolves the UI notice with the same clock rules as the API", () => {
    const env = { UTIX_SERVICE_MODE: "paused", UTIX_SERVICE_UNTIL: iso(NOW + HOUR) };
    expect(serviceNoticeFromEnv(env, NOW).mode).toBe("paused");
    expect(serviceNoticeFromEnv(env, NOW + HOUR).mode).toBe("normal");
  });
});

describe("buildStatusResponse", () => {
  let sink: TelemetryCaptureSink;

  beforeEach(() => {
    sink = createCaptureSink();
    setTelemetrySink(sink);
  });

  afterEach(() => resetTelemetrySink());

  it("publishes an operational, uncacheable status by default", () => {
    const response = buildStatusResponse({}, NOW);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.body as StatusResponseBody;
    expect(body.notice.mode).toBe("normal");
    expect(body.feed.status).toBe("operational");
    expect(body.feed.components).toEqual([{ id: "tools", name: "Stellar tools", status: "operational" }]);
  });

  it.each([
    ["degraded", "degraded"],
    ["maintenance", "maintenance"],
    ["paused", "major_outage"]
  ])("keeps the notice and the feed consistent for %s", (mode, overall) => {
    const body = buildStatusResponse({ UTIX_SERVICE_MODE: mode, UTIX_SERVICE_MESSAGE: "Working on it." }, NOW)
      .body as StatusResponseBody;
    expect(body.notice).toMatchObject({ mode, message: "Working on it." });
    expect(body.feed.status).toBe(overall);
    expect(validatePublicServiceNotice(body.notice).ok).toBe(true);
    expect(validatePublicStatusFeed(body.feed).ok).toBe(true);
  });

  it("never publishes a rejected value, and reports the problem as a code", () => {
    const response = buildStatusResponse({ UTIX_SERVICE_MODE: "paused", UTIX_SERVICE_MESSAGE: `token=${secret}` }, NOW);
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(JSON.stringify(sink.events)).not.toContain(secret);
    expect(sink.find((e) => e.op === "status.service_mode_config")).toMatchObject({
      result: "failure",
      errorCode: "unsafe_service_message"
    });
  });

  it("returns to normal once the configured window has passed", () => {
    const env = { UTIX_SERVICE_MODE: "maintenance", UTIX_SERVICE_UNTIL: iso(NOW + HOUR) };
    expect((buildStatusResponse(env, NOW + HOUR).body as StatusResponseBody).feed.status).toBe("operational");
  });

  it("answers 503 without detail when the feed would not validate", () => {
    const response = buildStatusResponse({}, NOW, {
      components: [{ id: "", name: "", status: "operational", visibility: "public" }],
      incidents: [],
      maintenance: []
    });
    expect(response).toMatchObject({ status: 503, body: { error: "status_unavailable" } });
    expect(sink.find((e) => e.op === "status.publish")?.errorCode).toBe("invalid_status_feed");
  });
});

describe("GET /api/status", () => {
  const original = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("UTIX_SERVICE_")) delete process.env[key];
    Object.assign(process.env, original);
  });

  it("serves the notice and feed from the environment at request time", async () => {
    process.env.UTIX_SERVICE_MODE = "degraded";
    process.env.UTIX_SERVICE_MESSAGE = "Horizon is slow.";

    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as StatusResponseBody;
    expect(body.notice).toMatchObject({ mode: "degraded", message: "Horizon is slow." });
    expect(body.feed.status).toBe("degraded");

    delete process.env.UTIX_SERVICE_MODE;
    expect(((await GET().json()) as StatusResponseBody).notice.mode).toBe("normal");
  });

  it("gives server components the same notice the API serves", () => {
    process.env.UTIX_SERVICE_MODE = "paused";
    expect(currentServiceNotice().mode).toBe("paused");
  });
});
