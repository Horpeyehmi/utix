import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createIsolatedAuditTrail, type AuditActor } from "@/core/audit/audit";
import {
  createCaptureSink,
  resetTelemetrySink,
  setTelemetrySink,
  type TelemetryCaptureSink
} from "@/core/telemetry/telemetry";
import { createWorkerFramework } from "@/core/workers/queue";
import { buildPublicStatusFeed, worseComponentStatus } from "../feed";
import {
  applyServiceMode,
  checkServiceMessage,
  createServiceModeStore,
  effectiveServiceMode,
  NORMAL_SERVICE,
  parseServiceModeChange,
  PUBLIC_SERVICE_NOTICE_SCHEMA_VERSION,
  registerServiceModeJobs,
  SERVICE_MESSAGE_MAX_LENGTH,
  SERVICE_MODE_EXPIRY_OP,
  toPublicServiceNotice,
  validatePublicServiceNotice,
  type ServiceModeState
} from "../service-mode";
import type { TrustedStatusState } from "../types";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

const maintainer: AuditActor = { kind: "maintainer", id: "ada" };
const user: AuditActor = { kind: "user", id: "mallory" };

const secret = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).secret();

const paused: ServiceModeState = {
  mode: "paused",
  message: "Tools are paused while we investigate a Horizon issue.",
  since: iso(NOW - HOUR),
  until: iso(NOW + HOUR),
  reason: "incident:inc-42",
  changedBy: "ada"
};

const trusted: TrustedStatusState = {
  components: [
    { id: "tools", name: "Stellar tools", status: "operational", visibility: "public" },
    { id: "horizon", name: "Horizon", status: "partial_outage", visibility: "public" },
    {
      id: "worker-queue",
      name: "Internal worker queue",
      status: "operational",
      visibility: "internal",
      diagnostics: { host: "10.0.0.5" }
    }
  ],
  incidents: [],
  maintenance: []
};

function trailBackedStore(initial?: ServiceModeState, trail = createIsolatedAuditTrail()) {
  let now = NOW;
  const store = createServiceModeStore({
    initial,
    now: () => now,
    record: (input) => {
      const result = trail.record(input);
      return result.ok ? result.value : undefined;
    }
  });
  return { store, trail, advance: (ms: number) => (now += ms) };
}

describe("checkServiceMessage", () => {
  it("accepts and normalises plain public text", () => {
    expect(checkServiceMessage("  Horizon is slow.\n  Retrying helps.  ")).toEqual({
      ok: true,
      value: "Horizon is slow. Retrying helps."
    });
  });

  it.each([
    ["", "service_message_required"],
    ["   ", "service_message_required"],
    [undefined, "service_message_required"],
    [42, "service_message_required"],
    ["x".repeat(SERVICE_MESSAGE_MAX_LENGTH + 1), "service_message_too_long"]
  ])("rejects %j with %s", (value, code) => {
    expect(checkServiceMessage(value)).toMatchObject({ ok: false, code });
  });

  it.each([
    [`Rotate ${secret} now`],
    ["Use Bearer abc.def.ghi to retry"],
    ["See https://ops:hunter2@status.internal/"],
    ["api_key=12345 was revoked"],
    ["password: swordfish"],
    ["Upstream 10.0.0.5 is down"],
    ["Upstream 192.168.1.20 is down"],
    ["Upstream 172.20.1.4 is down"],
    ["Proxy on localhost failed"],
    ["Error at run (worker.ts:42:7)"]
  ])("refuses a message that leaks internals: %s", (value) => {
    expect(checkServiceMessage(value)).toMatchObject({ ok: false, code: "unsafe_service_message" });
  });

  it("does not mistake public addresses and public hosts for secrets", () => {
    const address = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
    expect(checkServiceMessage(`Lookups for ${address} on horizon.stellar.org are slow.`).ok).toBe(true);
  });
});

describe("effectiveServiceMode", () => {
  it("is the stored mode inside its window", () => {
    expect(effectiveServiceMode(paused, NOW)).toBe(paused);
  });

  it("is normal before a scheduled start and from the end onwards", () => {
    expect(effectiveServiceMode({ ...paused, since: iso(NOW + 1) }, NOW)).toEqual(NORMAL_SERVICE);
    expect(effectiveServiceMode(paused, Date.parse(paused.until!))).toEqual(NORMAL_SERVICE);
  });

  it("keeps an open-ended mode indefinitely", () => {
    expect(effectiveServiceMode({ ...paused, until: null }, NOW + 1000 * HOUR).mode).toBe("paused");
  });
});

describe("toPublicServiceNotice", () => {
  it("publishes only the public fields", () => {
    const notice = toPublicServiceNotice(paused, NOW);
    expect(notice).toEqual({
      schemaVersion: PUBLIC_SERVICE_NOTICE_SCHEMA_VERSION,
      mode: "paused",
      message: paused.message,
      since: paused.since,
      until: paused.until
    });
    const json = JSON.stringify(notice);
    expect(json).not.toContain("incident:inc-42");
    expect(json).not.toContain("ada");
    expect(validatePublicServiceNotice(notice).ok).toBe(true);
  });

  it("publishes a bare normal notice once the window has passed", () => {
    expect(toPublicServiceNotice(paused, NOW + 2 * HOUR)).toEqual({
      schemaVersion: PUBLIC_SERVICE_NOTICE_SCHEMA_VERSION,
      mode: "normal",
      message: null,
      since: null,
      until: null
    });
  });
});

describe("validatePublicServiceNotice", () => {
  const notice = toPublicServiceNotice(paused, NOW);

  it.each([
    [null, "$"],
    [{ ...notice, reason: "incident:inc-42" }, "$"],
    [{ ...notice, schemaVersion: "2.0.0" }, "schemaVersion"],
    [{ ...notice, mode: "offline" }, "mode"],
    [{ ...notice, message: `leak ${secret}` }, "message"],
    [{ ...notice, until: "tomorrow" }, "until"]
  ])("rejects an invalid notice at %j", (value, path) => {
    expect(validatePublicServiceNotice(value)).toEqual({ ok: false, code: "invalid_service_notice", detail: path });
  });
});

describe("applyServiceMode", () => {
  it.each([
    ["degraded", "degraded"],
    ["maintenance", "under_maintenance"],
    ["paused", "major_outage"]
  ] as const)("raises public components for %s", (mode, status) => {
    const applied = applyServiceMode(trusted, { ...paused, mode }, NOW);
    expect(applied.components.find((c) => c.id === "tools")?.status).toBe(status);
  });

  it("never lowers a component that is already worse", () => {
    const applied = applyServiceMode(trusted, { ...paused, mode: "degraded" }, NOW);
    expect(applied.components.find((c) => c.id === "horizon")?.status).toBe("partial_outage");
    expect(worseComponentStatus("major_outage", "under_maintenance")).toBe("major_outage");
  });

  it("leaves internal components and the normal mode alone", () => {
    const applied = applyServiceMode(trusted, paused, NOW);
    expect(applied.components.find((c) => c.id === "worker-queue")?.status).toBe("operational");
    expect(applyServiceMode(trusted, NORMAL_SERVICE, NOW)).toBe(trusted);
  });

  it("moves the overall feed status, and lets it recover after `until`", () => {
    expect(buildPublicStatusFeed(applyServiceMode(trusted, paused, NOW), NOW).status).toBe("major_outage");
    const later = NOW + 2 * HOUR;
    expect(buildPublicStatusFeed(applyServiceMode(trusted, paused, later), later).status).toBe("partial_outage");
  });
});

describe("parseServiceModeChange", () => {
  const request = { mode: "maintenance", message: "Upgrading the indexer.", reason: "change:chg-7" };

  it("defaults since to now and accepts an open-ended mode", () => {
    expect(parseServiceModeChange(request, NOW)).toEqual({
      ok: true,
      value: { mode: "maintenance", message: "Upgrading the indexer.", since: iso(NOW), until: null, reason: "change:chg-7" }
    });
  });

  it("drops the message when returning to normal", () => {
    expect(parseServiceModeChange({ mode: "normal", message: "ignored", reason: "resolved" }, NOW)).toEqual({
      ok: true,
      value: { ...NORMAL_SERVICE, reason: "resolved" }
    });
  });

  it.each([
    [{ ...request, mode: "offline" }, "invalid_service_mode"],
    [{ ...request, reason: "Because I said so" }, "invalid_service_reason"],
    [{ ...request, message: undefined }, "service_message_required"],
    [{ ...request, message: `use ${secret}` }, "unsafe_service_message"],
    [{ ...request, until: "soon" }, "invalid_service_window"],
    [{ ...request, until: iso(NOW - 1) }, "invalid_service_window"],
    [{ ...request, since: iso(NOW + 2 * HOUR), until: iso(NOW + HOUR) }, "invalid_service_window"]
  ])("rejects %j with %s", (value, code) => {
    expect(parseServiceModeChange(value, NOW)).toMatchObject({ ok: false, code });
  });
});

describe("createServiceModeStore", () => {
  let sink: TelemetryCaptureSink;

  beforeEach(() => {
    sink = createCaptureSink();
    setTelemetrySink(sink);
  });

  afterEach(() => resetTelemetrySink());

  it("applies a maintainer's change after auditing it", () => {
    const { store, trail } = trailBackedStore();
    const result = store.change(maintainer, {
      mode: "degraded",
      message: "Horizon is slow.",
      until: iso(NOW + HOUR),
      reason: "incident:inc-42"
    });

    expect(result.ok).toBe(true);
    expect(store.current().mode).toBe("degraded");
    expect(store.stored().changedBy).toBe("ada");

    const [event] = trail.all();
    expect(event).toMatchObject({
      action: "service_mode.changed",
      outcome: "allowed",
      actorId: "ada",
      reason: "incident:inc-42",
      target: { kind: "service_mode", id: "app" },
      before: { mode: "normal", until: null },
      after: { mode: "degraded", until: iso(NOW + HOUR) }
    });
    // The public message is not copied into the trail.
    expect(JSON.stringify(event)).not.toContain("Horizon is slow");
    expect(sink.find((e) => e.op === "status.service_mode_change")).toMatchObject({
      result: "success",
      payload: { from: "normal", to: "degraded" }
    });
  });

  it("refuses a plain user and records the attempt", () => {
    const { store, trail } = trailBackedStore();
    expect(store.change(user, { mode: "paused", message: "Paused.", reason: "prank" })).toEqual({
      ok: false,
      code: "service_mode_forbidden"
    });
    expect(store.current().mode).toBe("normal");
    expect(trail.all()[0]).toMatchObject({ outcome: "denied", errorCode: "service_mode_forbidden" });
    expect(sink.latest()).toMatchObject({ result: "failure", errorCode: "service_mode_forbidden" });
  });

  it("records an invalid request as denied without changing the mode", () => {
    const { store, trail } = trailBackedStore(paused);
    expect(store.change(maintainer, { mode: "degraded", message: `oops ${secret}`, reason: "incident:inc-42" })).toEqual({
      ok: false,
      code: "unsafe_service_message"
    });
    expect(store.stored()).toBe(paused);
    expect(JSON.stringify(trail.all())).not.toContain(secret);
    expect(JSON.stringify(sink.events)).not.toContain(secret);
  });

  it("does not change the mode when the audit trail rejects the event", () => {
    const store = createServiceModeStore({ now: () => NOW, record: () => undefined });
    expect(store.change(maintainer, { mode: "paused", message: "Paused.", reason: "incident:inc-1" })).toEqual({
      ok: false,
      code: "service_mode_audit_rejected"
    });
    expect(store.current().mode).toBe("normal");
  });

  it("lets the system actor set and clear the mode", () => {
    const { store } = trailBackedStore();
    expect(store.change({ kind: "system", id: "rollout-guard" }, { mode: "degraded", message: "Rolling back.", reason: "rollback" }).ok).toBe(true);
    expect(store.change(maintainer, { mode: "normal", reason: "resolved" }).ok).toBe(true);
    expect(store.notice().mode).toBe("normal");
  });

  it("expires a lapsed mode once, recording the automatic recovery", () => {
    const { store, trail, advance } = trailBackedStore(paused);
    expect(store.expire()).toBe(false);

    advance(HOUR);
    expect(store.expire()).toBe(true);
    expect(store.expire()).toBe(false);
    expect(store.stored().mode).toBe("normal");
    expect(trail.all().map((event) => [event.action, event.actorId, event.reason])).toEqual([
      ["service_mode.expired", SERVICE_MODE_EXPIRY_OP, "service_mode:until_reached"]
    ]);
    expect(sink.find((e) => e.op === "status.service_mode_expired")?.actorType).toBe("system");
  });
});

describe("status.expire_service_mode background job", () => {
  it("returns a lapsed mode to normal when the worker runs it", () => {
    const { store, trail, advance } = trailBackedStore(paused);
    const framework = registerServiceModeJobs(createWorkerFramework(), store);

    advance(2 * HOUR);
    framework.enqueue({ operation: SERVICE_MODE_EXPIRY_OP });
    const summary = framework.drainDueJobs();

    expect(summary.succeeded).toBe(1);
    expect(store.stored().mode).toBe("normal");
    expect(trail.all()).toHaveLength(1);
  });

  it("is a harmless no-op when run early", () => {
    const { store, trail } = trailBackedStore(paused);
    const framework = registerServiceModeJobs(createWorkerFramework(), store);

    framework.enqueue({ operation: SERVICE_MODE_EXPIRY_OP });
    expect(framework.drainDueJobs().succeeded).toBe(1);
    expect(store.stored()).toBe(paused);
    expect(trail.all()).toHaveLength(0);
  });
});
