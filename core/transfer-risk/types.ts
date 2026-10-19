import type { TransferTicketParams } from "@/core/invariants/mutations";

export type TransferRiskStatus = "review_required" | "blocked" | "approved" | "rejected" | "completed";
export type TransferRiskCode = "transfer_review_required" | "transfer_blocked" | "transfer_rejected" | "transfer_completed" | "transfer_approved" | "invalid_risk_context";
export type RiskSignal = "rapid_resale" | "device_changes" | "recipient_pattern" | "unusual_timing" | "repeated_attempts";

export interface TransferRiskPolicy {
  readonly rapidResaleMs: number;
  readonly deviceWindowMs: number;
  readonly maxDeviceChanges: number;
  readonly recipientWindowMs: number;
  readonly maxRecipientTransfers: number;
  readonly lateTransferMs: number;
  readonly retryWindowMs: number;
  readonly maxAttempts: number;
  readonly weights: Readonly<Record<RiskSignal, number>>;
  readonly reviewScore: number;
  readonly blockScore: number;
}

/** Trusted server inputs. Never populate these from a request body's risk hints. */
export interface TransferRiskContext {
  readonly now?: number;
  /** Opaque device fingerprint from the authenticated session, not a raw device identifier. */
  readonly deviceId?: string;
  readonly policy?: TransferRiskPolicy;
}

export interface TransferRiskAttempt {
  readonly id: string;
  readonly request: TransferTicketParams;
  readonly ticketVersion: number;
  readonly submittedAt: number;
  readonly status: TransferRiskStatus;
  readonly deviceId?: string;
  /** Internal review data. Do not serialize this object to an attendee. */
  readonly score: number;
  readonly signals: readonly RiskSignal[];
}

/** Actor must come from the application's authenticated, server-side principal. */
export interface TransferReviewer {
  readonly kind: "organizer" | "maintainer";
  readonly id: string;
}

export interface TransferRiskAudit {
  readonly transferId: string;
  readonly actor: { readonly kind: "user" | "organizer" | "maintainer" | "system"; readonly id: string };
  readonly reason: string;
  readonly timestamp: number;
  readonly status: TransferRiskStatus;
}

export interface TransferRiskState {
  readonly attempts: readonly TransferRiskAttempt[];
  readonly audit: readonly TransferRiskAudit[];
}

export interface TransferRiskAssessment {
  readonly disposition: "allow" | "review" | "block";
  readonly score: number;
  readonly signals: readonly RiskSignal[];
  readonly code: TransferRiskCode;
}
