import type { DomainState } from "@/core/invariants/types";
import type { TransferTicketParams } from "@/core/invariants/mutations";
import type { RiskSignal, TransferRiskAssessment, TransferRiskContext, TransferRiskPolicy } from "./types";

export const DEFAULT_TRANSFER_RISK_POLICY: TransferRiskPolicy = Object.freeze({
  rapidResaleMs: 5 * 60_000,
  deviceWindowMs: 60 * 60_000,
  maxDeviceChanges: 3,
  recipientWindowMs: 60 * 60_000,
  maxRecipientTransfers: 5,
  lateTransferMs: 10 * 60_000,
  retryWindowMs: 10 * 60_000,
  maxAttempts: 5,
  weights: Object.freeze({ rapid_resale: 40, device_changes: 30, recipient_pattern: 40, unusual_timing: 25, repeated_attempts: 40 }),
  reviewScore: 40,
  blockScore: 80
});

export function validRiskContext(context: TransferRiskContext): boolean {
  const policy = context.policy ?? DEFAULT_TRANSFER_RISK_POLICY;
  const numbers = [policy.rapidResaleMs, policy.deviceWindowMs, policy.maxDeviceChanges, policy.recipientWindowMs,
    policy.maxRecipientTransfers, policy.lateTransferMs, policy.retryWindowMs, policy.maxAttempts,
    policy.reviewScore, policy.blockScore, ...Object.values(policy.weights ?? {})];
  return numbers.every((value) => Number.isSafeInteger(value) && value > 0) &&
    Object.values(policy.weights ?? {}).every((value) => value <= 1_000_000) &&
    Object.keys(DEFAULT_TRANSFER_RISK_POLICY.weights).every((key) => Object.hasOwn(policy.weights ?? {}, key)) &&
    policy.blockScore > policy.reviewScore &&
    (context.now === undefined || (Number.isSafeInteger(context.now) && context.now >= 0)) &&
    (context.deviceId === undefined || /^[a-zA-Z0-9:_-]{1,128}$/.test(context.deviceId));
}

/** Bind approval and idempotency to every value-bearing field, not just an ID. */
export function sameTransfer(a: TransferTicketParams, b: TransferTicketParams): boolean {
  return a.id === b.id && a.ticketId === b.ticketId && a.fromAddress === b.fromAddress && a.toAddress === b.toAddress &&
    a.nonce === b.nonce && a.priceStroops === b.priceStroops && a.organizerFeeStroops === b.organizerFeeStroops &&
    a.protocolFeeStroops === b.protocolFeeStroops && a.sellerProceedsStroops === b.sellerProceedsStroops;
}

export function assessTransferRisk(state: DomainState, request: TransferTicketParams, context: TransferRiskContext = {}): TransferRiskAssessment {
  if (!validRiskContext(context)) return { disposition: "block", score: 0, signals: [], code: "invalid_risk_context" };
  const now = context.now ?? Date.now(), policy = context.policy ?? DEFAULT_TRANSFER_RISK_POLICY;
  const ticket = state.tickets.get(request.ticketId);
  if (!ticket) return { disposition: "block", score: 0, signals: [], code: "transfer_blocked" };
  const attempts = state.transferRisk?.attempts ?? [];
  const existing = attempts.find((attempt) => attempt.id === request.id || attempt.request.nonce === request.nonce);
  if (existing && (!sameTransfer(existing.request, request) || existing.ticketVersion !== ticket.nonce)) {
    return { disposition: "block", score: 0, signals: [], code: "transfer_blocked" };
  }
  const fresh = (time: number, window: number) => time <= now && now - time <= window;
  const ticketTransfers = state.transfers.filter((transfer) => transfer.ticketId === ticket.id);
  const actorAttempts = attempts.filter((attempt) => attempt.request.fromAddress === request.fromAddress);
  const devices = actorAttempts.filter((attempt) => fresh(attempt.submittedAt, policy.deviceWindowMs)).sort((left, right) => left.submittedAt - right.submittedAt).map((attempt) => attempt.deviceId).filter((device): device is string => device !== undefined);
  if (context.deviceId) devices.push(context.deviceId);
  let changes = 0;
  for (let index = 1; index < devices.length; index++) if (devices[index] !== devices[index - 1]) changes++;
  const signals: RiskSignal[] = [];
  if (ticketTransfers.some((transfer) => fresh(transfer.timestamp, policy.rapidResaleMs))) signals.push("rapid_resale");
  if (changes >= policy.maxDeviceChanges) signals.push("device_changes");
  if (state.transfers.filter((transfer) => transfer.toAddress === request.toAddress && fresh(transfer.timestamp, policy.recipientWindowMs)).length >= policy.maxRecipientTransfers) signals.push("recipient_pattern");
  if (ticket.validUntil >= now && ticket.validUntil - now <= policy.lateTransferMs) signals.push("unusual_timing");
  if (actorAttempts.filter((attempt) => fresh(attempt.submittedAt, policy.retryWindowMs)).length >= policy.maxAttempts) signals.push("repeated_attempts");
  const score = signals.reduce((total, signal) => total + policy.weights[signal], 0);
  // Decisions reserve a particular ownership version: changing nonce/recipient/ID cannot bypass review.
  const active = attempts.filter((attempt) => attempt.request.ticketId === ticket.id && attempt.ticketVersion === ticket.nonce);
  if (active.some((attempt) => attempt.status === "rejected")) return { disposition: "block", score, signals, code: "transfer_rejected" };
  if (active.some((attempt) => attempt.status === "blocked") || score >= policy.blockScore) return { disposition: "block", score, signals, code: "transfer_blocked" };
  const approved = active.find((attempt) => attempt.status === "approved" && sameTransfer(attempt.request, request));
  if (approved) return { disposition: "allow", score, signals, code: "transfer_approved" };
  if (active.some((attempt) => attempt.status === "review_required" || attempt.status === "approved") || score >= policy.reviewScore) return { disposition: "review", score, signals, code: "transfer_review_required" };
  return { disposition: "allow", score, signals, code: "transfer_completed" };
}
