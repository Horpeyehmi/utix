import { err, ok, type Result } from "@/core/result/result";
import type { DomainState } from "@/core/invariants/types";
import { transferTicket, validateTicketTransfer, type TransferTicketParams } from "@/core/invariants/mutations";
import { assessTransferRisk, sameTransfer, validRiskContext } from "./policy";
import { recordTransferAttempt } from "./records";
import type { TransferReviewer, TransferRiskCode, TransferRiskContext, TransferRiskStatus } from "./types";

export type TransferWorkflowError = "idempotency_conflict" | "invalid_transfer" | "review_not_found" | "review_forbidden" | "invalid_review_reason" | "review_already_decided" | "stale_review" | "invalid_risk_context";

/** Run in commitMutation against server-owned state. Queued/blocked outcomes are committed, too. */
export function requestTicketTransfer(state: DomainState, request: TransferTicketParams, context: TransferRiskContext = {}): Result<DomainState, TransferWorkflowError> {
  if (!validRiskContext(context)) return err("invalid_risk_context");
  const existing = state.transferRisk?.attempts.find((attempt) => attempt.id === request.id || attempt.request.nonce === request.nonce);
  if (existing && !sameTransfer(existing.request, request)) return err("idempotency_conflict");
  if (existing && existing.status !== "approved") return ok(state);
  if (existing && state.tickets.get(request.ticketId)?.nonce !== existing.ticketVersion) return err("stale_review");
  const valid = validateTicketTransfer(state, request);
  if (!valid.ok) return err("invalid_transfer");
  const assessment = assessTransferRisk(state, request, context);
  if (assessment.code === "invalid_risk_context") return err("invalid_risk_context");
  if (assessment.disposition !== "allow") return ok(recordTransferAttempt(state, request, valid.value.nonce,
    assessment.code === "transfer_rejected" ? "rejected" : assessment.disposition === "review" ? "review_required" : "blocked", assessment, context));
  const completed = transferTicket(state, request, context);
  return completed.ok ? ok(completed.value) : err("invalid_transfer");
}

function mayReview(state: DomainState, ticketId: string, actor: TransferReviewer): boolean {
  const ticket = state.tickets.get(ticketId), event = ticket && state.events.get(ticket.eventId);
  return Boolean(event && actor.id.trim() && (actor.kind === "maintainer" || (actor.kind === "organizer" && actor.id === event.organizerAddress)));
}

export function reviewTicketTransfer(state: DomainState, transferId: string,
  decision: "approve" | "reject", actor: TransferReviewer, reason: string, now = Date.now()): Result<DomainState, TransferWorkflowError> {
  const previous = state.transferRisk, attempt = previous?.attempts.find((item) => item.id === transferId);
  if (!attempt || !previous) return err("review_not_found");
  if (!mayReview(state, attempt.request.ticketId, actor) || actor.id === attempt.request.fromAddress || actor.id === attempt.request.toAddress) return err("review_forbidden");
  if (!/^[a-z0-9_.:-]{1,64}$/.test(reason) || (decision !== "approve" && decision !== "reject")) return err("invalid_review_reason");
  if (!Number.isSafeInteger(now) || now < attempt.submittedAt) return err("invalid_risk_context");
  if (attempt.status !== "review_required") return err("review_already_decided");
  const ticket = state.tickets.get(attempt.request.ticketId);
  if (!ticket || ticket.nonce !== attempt.ticketVersion || ticket.ownerAddress !== attempt.request.fromAddress ||
      (ticket.status !== "issued" && ticket.status !== "transferred") || ticket.fraudFlag) return err("stale_review");
  const status = decision === "approve" ? "approved" : "rejected";
  return ok({ ...state, transferRisk: {
    attempts: previous.attempts.map((item) => item.id === transferId ? { ...item, status } : item),
    audit: [...previous.audit, { transferId, actor: { ...actor }, reason, timestamp: now, status }]
  } });
}

export function pendingTransferReviews(state: DomainState, actor: TransferReviewer) {
  return (state.transferRisk?.attempts ?? []).filter((attempt) => attempt.status === "review_required" &&
    state.tickets.get(attempt.request.ticketId)?.nonce === attempt.ticketVersion && mayReview(state, attempt.request.ticketId, actor));
}

const PUBLIC_CODES: Record<TransferRiskStatus, TransferRiskCode> = {
  review_required: "transfer_review_required", blocked: "transfer_blocked", approved: "transfer_approved", rejected: "transfer_rejected", completed: "transfer_completed"
};
const PUBLIC_MESSAGES: Record<TransferRiskStatus, string> = {
  review_required: "This transfer needs organizer review before it can continue.",
  blocked: "This transfer cannot continue. Contact the organizer for help.",
  approved: "Review approved. Retry the same transfer request to complete it.",
  rejected: "The transfer was declined during review. Contact the organizer for help.",
  completed: "The transfer is complete."
};

/** Authorize ownership of this request before returning its public status to a user. */
export function publicTransferStatus(state: DomainState, transferId: string, principalId: string) {
  const attempt = state.transferRisk?.attempts.find((item) => item.id === transferId && item.request.fromAddress === principalId);
  return attempt ? { transferId: attempt.id, status: attempt.status, code: PUBLIC_CODES[attempt.status], message: PUBLIC_MESSAGES[attempt.status] } : null;
}
