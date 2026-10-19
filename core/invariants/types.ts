/**
 * Domain Types and Invariant Specifications (#78)
 *
 * Formal domain model for Utix ticketing, access control, and token settlement.
 * Defines invariants that assert the domain model cannot enter impossible states
 * through API, UI, worker, or contract paths.
 */

export type TicketStatus =
  | 'issued'
  | 'transferred'
  | 'locked'
  | 'redeemed'
  | 'expired'
  | 'burned';

export type EventStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled';

export interface Ticket {
  readonly id: string;
  readonly eventId: string;
  readonly tierId: string;
  readonly ownerAddress: string;
  readonly priceStroops: number;
  readonly status: TicketStatus;
  readonly issuedAt: number;
  readonly validFrom: number;
  readonly validUntil: number;
  readonly fraudFlag: boolean;
  readonly nonce: number;
  readonly metadataHash: string;
}

export interface Event {
  readonly id: string;
  readonly organizerAddress: string;
  readonly totalCapacity: number;
  readonly issuedCount: number;
  readonly status: EventStatus;
  readonly feeBasisPoints: number; // e.g., 250 for 2.5%
}

export interface TransferRecord {
  readonly id: string;
  readonly ticketId: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly priceStroops: number;
  readonly organizerFeeStroops: number;
  readonly protocolFeeStroops: number;
  readonly sellerProceedsStroops: number;
  readonly nonce: string;
  readonly timestamp: number;
}

export interface DomainState {
  readonly events: ReadonlyMap<string, Event>;
  readonly tickets: ReadonlyMap<string, Ticket>;
  readonly transfers: readonly TransferRecord[];
  readonly processedNonces: ReadonlySet<string>;
  readonly blacklistedAddresses: ReadonlySet<string>;
  /** Persist with the ownership mutation; never expose this internal state in an attendee response. */
  readonly transferRisk?: import("@/core/transfer-risk/types").TransferRiskState;
}

export type InvariantId =
  | 'INV-01' // Non-Negative & Capacity-Bounded Supply
  | 'INV-02' // Single Active Ownership
  | 'INV-03' // Terminal State Immutability
  | 'INV-04' // Valid Sequential Lifecycle Progression
  | 'INV-05' // Escrow / Fraud Lock Transfer Bar
  | 'INV-06' // Value Conservation & Zero-Sum Fee Split
  | 'INV-07' // Stroop Precision & Positive Bounds
  | 'INV-08' // Timebound Redemption Validity Window
  | 'INV-09' // Nonce & Idempotency Replay Protection
  | 'INV-10' // Organizer Event Solvency & Capacity Conservation
  | 'INV-11'; // Blacklisted Principal Action Quarantine

export interface InvariantViolation {
  readonly code?: import("@/core/transfer-risk/types").TransferRiskCode;
  readonly invariantId: InvariantId;
  readonly name: string;
  readonly severity: 'critical' | 'high' | 'medium';
  readonly entityId: string;
  readonly entityType: 'ticket' | 'event' | 'transfer' | 'account';
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

export class InvariantViolationError extends Error {
  public readonly violations: readonly InvariantViolation[];

  constructor(violations: readonly InvariantViolation[]) {
    super(
      `Domain invariant violation(s) detected:\n` +
        violations.map((v) => `  [${v.invariantId}] ${v.name}: ${v.message} (Entity: ${v.entityType}#${v.entityId})`).join('\n')
    );
    this.name = 'InvariantViolationError';
    this.violations = violations;
  }
}
