import type { DomainState } from "@/core/invariants/types";
import type { TransferTicketParams } from "@/core/invariants/mutations";
import type { TransferRiskAssessment, TransferRiskContext, TransferRiskStatus } from "./types";

/** Part of the same immutable state commit as ownership and nonce changes. */
export function recordTransferAttempt(state: DomainState, request: TransferTicketParams, version: number,
  status: TransferRiskStatus, assessment: TransferRiskAssessment, context: TransferRiskContext): DomainState {
  const timestamp = context.now ?? Date.now(), previous = state.transferRisk ?? { attempts: [], audit: [] };
  const existing = previous.attempts.find((attempt) => attempt.id === request.id);
  const attempt = { id: request.id, request: { ...request, timestamp }, ticketVersion: version,
    submittedAt: existing?.submittedAt ?? timestamp, status, score: assessment.score, signals: [...assessment.signals], deviceId: existing?.deviceId ?? context.deviceId };
  const superseded = status === "completed" ? previous.attempts.filter((item) => item.id !== request.id &&
    item.request.ticketId === request.ticketId && item.ticketVersion === version &&
    (item.status === "review_required" || item.status === "approved")) : [];
  return { ...state, transferRisk: {
    attempts: [...previous.attempts.filter((item) => item.id !== request.id).map((item) =>
      superseded.includes(item) ? { ...item, status: "blocked" as const } : item), attempt],
    audit: [...previous.audit,
      ...superseded.map((item) => ({ transferId: item.id, actor: { kind: "system" as const, id: "transfer-risk" }, reason: "ownership_changed", timestamp, status: "blocked" as const })),
      { transferId: request.id, actor: { kind: "user", id: request.fromAddress }, reason: assessment.code, timestamp, status }]
  } };
}
