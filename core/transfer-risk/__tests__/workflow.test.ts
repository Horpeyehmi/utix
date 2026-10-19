import { describe, expect, it } from "vitest";
import { createMemoryStateCell, commitMutation } from "@/core/invariants/commit";
import { transferTicket, type TransferTicketParams } from "@/core/invariants/mutations";
import type { DomainState, Ticket } from "@/core/invariants/types";
import { DEFAULT_TRANSFER_RISK_POLICY, assessTransferRisk } from "../policy";
import { pendingTransferReviews, publicTransferStatus, requestTicketTransfer, reviewTicketTransfer } from "../workflow";

const NOW = 1_800_000_000_000;
const context = { now: NOW, deviceId: "device-one" };
const organizer = { kind: "organizer" as const, id: "organizer" };
const maintainer = { kind: "maintainer" as const, id: "maintainer" };
function state(): DomainState {
  const ticket: Ticket = { id: "ticket", eventId: "event", tierId: "general", ownerAddress: "alice", priceStroops: 100,
    status: "issued", issuedAt: NOW - 86_400_000, validFrom: NOW + 3_600_000, validUntil: NOW + 7_200_000, fraudFlag: false, nonce: 0, metadataHash: "" };
  return { events: new Map([["event", { id: "event", organizerAddress: organizer.id, totalCapacity: 100, issuedCount: 1, status: "active", feeBasisPoints: 0 }]]),
    tickets: new Map([[ticket.id, ticket]]), transfers: [], processedNonces: new Set(), blacklistedAddresses: new Set() };
}
function request(overrides: Partial<TransferTicketParams> = {}): TransferTicketParams {
  return { id: "transfer", ticketId: "ticket", fromAddress: "alice", toAddress: "bob", priceStroops: 100,
    organizerFeeStroops: 5, protocolFeeStroops: 5, sellerProceedsStroops: 90, nonce: "nonce", ...overrides };
}
function risky(): DomainState {
  return { ...state(), transfers: [{ ...request({ id: "previous", nonce: "previous-nonce", fromAddress: "previous-owner", toAddress: "alice" }), timestamp: NOW - 1000 }] };
}
function value<T>(result: { ok: true; value: T } | { ok: false; code: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.code));
  return result.value;
}

describe("server-side transfer risk workflow", () => {
  it("completes a normal transfer atomically with history and nonce", () => {
    const initial = state(), next = value(requestTicketTransfer(initial, request(), context));
    expect(next.tickets.get("ticket")?.ownerAddress).toBe("bob");
    expect(next.processedNonces.has("nonce")).toBe(true);
    expect(next.transferRisk?.attempts[0].status).toBe("completed");
    expect(initial.tickets.get("ticket")?.ownerAddress).toBe("alice");
  });
  it("queues rapid resale before changing ownership or consuming the nonce", () => {
    const next = value(requestTicketTransfer(risky(), request(), context));
    expect(next.tickets.get("ticket")?.ownerAddress).toBe("alice");
    expect(next.processedNonces.has("nonce")).toBe(false);
    expect(next.transferRisk?.attempts[0]).toMatchObject({ status: "review_required", signals: ["rapid_resale"] });
    expect(pendingTransferReviews(next, organizer)).toHaveLength(1);
    expect(pendingTransferReviews(next, { kind: "organizer", id: "other-organizer" })).toEqual([]);
  });
  it("hard blocks combined rapid resale and suspicious recipient activity", () => {
    const initial = risky();
    const transfers = Array.from({ length: 5 }, (_, index) => ({ ...request({ id: `other-${index}`, nonce: `other-${index}`, ticketId: `other-${index}` }), timestamp: NOW - 500 }));
    const next = value(requestTicketTransfer({ ...initial, transfers: [...initial.transfers, ...transfers] }, request(), context));
    expect(publicTransferStatus(next, "transfer", "alice")?.code).toBe("transfer_blocked");
    expect(next.tickets.get("ticket")?.ownerAddress).toBe("alice");
    expect(reviewTicketTransfer(next, "transfer", "approve", maintainer, "verified", NOW + 1)).toEqual({ ok: false, code: "review_already_decided" });
  });
  it("audits an authorized approval and completes only that exact request", () => {
    const queued = value(requestTicketTransfer(risky(), request(), context));
    const approved = value(reviewTicketTransfer(queued, "transfer", "approve", organizer, "identity_verified", NOW + 1));
    expect(approved.transferRisk?.audit.at(-1)).toEqual({ transferId: "transfer", actor: organizer, reason: "identity_verified", timestamp: NOW + 1, status: "approved" });
    const next = value(requestTicketTransfer(approved, request(), { ...context, now: NOW + 2 }));
    expect(next.tickets.get("ticket")?.ownerAddress).toBe("bob");
    expect(publicTransferStatus(next, "transfer", "alice")?.code).toBe("transfer_completed");
    expect(requestTicketTransfer(approved, request({ toAddress: "eve" }), context)).toEqual({ ok: false, code: "idempotency_conflict" });
  });
  it("retains rejection across repeated attempts and nonce rotation", () => {
    const queued = value(requestTicketTransfer(risky(), request(), context));
    const rejected = value(reviewTicketTransfer(queued, "transfer", "reject", maintainer, "recipient_unverified", NOW + 1));
    const replay = value(requestTicketTransfer(rejected, request(), context));
    expect(replay).toBe(rejected);
    const rotated = value(requestTicketTransfer(rejected, request({ id: "retry", nonce: "new-nonce", toAddress: "eve" }), context));
    expect(publicTransferStatus(rotated, "retry", "alice")?.code).toBe("transfer_rejected");
    expect(rotated.tickets.get("ticket")?.ownerAddress).toBe("alice");
  });
  it("makes completed retries idempotent and rejects key collisions", () => {
    const completed = value(requestTicketTransfer(state(), request(), context));
    expect(value(requestTicketTransfer(completed, request(), context))).toBe(completed);
    expect(completed.transfers).toHaveLength(1);
    expect(completed.transferRisk?.audit).toHaveLength(1);
    expect(requestTicketTransfer(completed, request({ id: "other" }), context)).toEqual({ ok: false, code: "idempotency_conflict" });
  });
  it("does not allow a different ID to skip a pending review", () => {
    const queued = value(requestTicketTransfer(risky(), request(), context));
    const later = value(requestTicketTransfer(queued, request({ id: "new-id", nonce: "new-nonce" }), { ...context, now: NOW + 3_600_000 }));
    expect(publicTransferStatus(later, "new-id", "alice")?.code).toBe("transfer_review_required");
    const direct = transferTicket(later, request({ id: "bypass", nonce: "bypass" }), { now: NOW + 3_600_000 });
    expect(!direct.ok && direct.code.code).toBe("transfer_review_required");
  });
  it("enforces review scope, attribution and valid reasons", () => {
    const queued = value(requestTicketTransfer(risky(), request(), context));
    expect(reviewTicketTransfer(queued, "transfer", "approve", { kind: "organizer", id: "other" }, "verified", NOW)).toEqual({ ok: false, code: "review_forbidden" });
    expect(reviewTicketTransfer(queued, "transfer", "approve", { kind: "maintainer", id: "alice" }, "verified", NOW)).toEqual({ ok: false, code: "review_forbidden" });
    expect(reviewTicketTransfer(queued, "transfer", "approve", organizer, "", NOW)).toEqual({ ok: false, code: "invalid_review_reason" });
    const approved = value(reviewTicketTransfer(queued, "transfer", "approve", organizer, "verified", NOW));
    expect(reviewTicketTransfer(approved, "transfer", "reject", organizer, "changed", NOW)).toEqual({ ok: false, code: "review_already_decided" });
  });
  it("cannot use an approval after ownership or lifecycle changes", () => {
    const queued = value(requestTicketTransfer(risky(), request(), context));
    const ticket = queued.tickets.get("ticket")!;
    const stale = { ...queued, tickets: new Map([["ticket", { ...ticket, nonce: 1 }]]) };
    expect(reviewTicketTransfer(stale, "transfer", "approve", maintainer, "verified", NOW)).toEqual({ ok: false, code: "stale_review" });
    const approved = value(reviewTicketTransfer(queued, "transfer", "approve", organizer, "verified", NOW));
    const advanced = { ...approved, tickets: new Map([["ticket", { ...ticket, nonce: 2 }]]) };
    expect(requestTicketTransfer(advanced, request(), context)).toEqual({ ok: false, code: "stale_review" });
    const locked = { ...approved, tickets: new Map([["ticket", { ...ticket, status: "locked" as const }]]) };
    expect(requestTicketTransfer(locked, request(), context)).toEqual({ ok: false, code: "invalid_transfer" });
  });
  it("rechecks hard-blocking risk even after an approval", () => {
    const queued = value(requestTicketTransfer(risky(), request(), context));
    const approved = value(reviewTicketTransfer(queued, "transfer", "approve", organizer, "verified", NOW));
    const suspicious = Array.from({ length: 5 }, (_, index) => ({ ...request({ id: `new-${index}`, nonce: `new-${index}`, ticketId: `other-${index}` }), timestamp: NOW }));
    const blocked = value(requestTicketTransfer({ ...approved, transfers: [...approved.transfers, ...suspicious] }, request(), context));
    expect(publicTransferStatus(blocked, "transfer", "alice")?.code).toBe("transfer_blocked");
    expect(blocked.tickets.get("ticket")?.ownerAddress).toBe("alice");
  });
  it("keeps fraud rules out of public explanations and scopes status reads", () => {
    const queued = value(requestTicketTransfer(risky(), request(), context));
    const publicResult = publicTransferStatus(queued, "transfer", "alice");
    expect(Object.keys(publicResult!)).toEqual(["transferId", "status", "code", "message"]);
    expect(JSON.stringify(publicResult)).not.toMatch(/rapid_resale|score|threshold|40000/);
    expect(publicTransferStatus(queued, "transfer", "eve")).toBeNull();
  });
  it("uses server time rather than a caller's transfer timestamp", () => {
    const initial = risky();
    const result = value(requestTicketTransfer(initial, request({ timestamp: NOW + 86_400_000 }), context));
    expect(result.transferRisk?.attempts[0].submittedAt).toBe(NOW);
    expect(result.transferRisk?.attempts[0].status).toBe("review_required");
  });
  it("rejects malformed policy and negative fees before any ownership mutation", () => {
    expect(requestTicketTransfer(state(), request(), { policy: { ...DEFAULT_TRANSFER_RISK_POLICY, reviewScore: -1 } })).toEqual({ ok: false, code: "invalid_risk_context" });
    expect(requestTicketTransfer(state(), request({ organizerFeeStroops: -5, sellerProceedsStroops: 100 }), context)).toEqual({ ok: false, code: "invalid_transfer" });
  });
  it("keeps a single committed transfer under racing identical retries", async () => {
    const cell = createMemoryStateCell(state());
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => commitMutation(cell, (snapshot) => requestTicketTransfer(snapshot, request(), context))));
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const committed = (await cell.read()).state;
    expect(committed.transfers).toHaveLength(1);
    expect(committed.transferRisk?.audit).toHaveLength(1);
  });
  it("scores unusual timing and repeated device changes from server history", () => {
    const initial = state(), template = initial.tickets.get("ticket")!;
    const attempts = ["one", "two", "three", "four"].map((deviceId, index) => ({ id: `history-${index}`, request: request({ ticketId: `old-${index}`, id: `history-${index}`, nonce: `history-${index}` }), ticketVersion: 0, submittedAt: NOW - 1000 + index, status: "completed" as const, score: 0, signals: [], deviceId }));
    const report = assessTransferRisk({ ...initial, tickets: new Map([["ticket", { ...template, validUntil: NOW + 1000 }]]), transferRisk: { attempts, audit: [] } }, request(), { ...context, deviceId: "four" });
    expect(report.signals).toEqual(["device_changes", "unusual_timing"]);
    expect(report.disposition).toBe("review");
    const repeated = assessTransferRisk({ ...initial, transferRisk: { attempts, audit: [] } }, request(), { ...context, policy: { ...DEFAULT_TRANSFER_RISK_POLICY, maxAttempts: 3 } });
    expect(repeated.signals).toContain("repeated_attempts");
  });
});
