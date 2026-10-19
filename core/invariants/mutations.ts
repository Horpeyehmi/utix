/**
 * Invariant-Guarded Domain Mutations (#78)
 *
 * Provides safe state mutation functions for ticket issuance, secondary transfers,
 * redemptions, fraud locking, and burning that automatically uphold all domain invariants.
 */

import { ok } from '@/core/result/result';
import { defaultOwnershipStore } from '@/core/ownership/ownership';
import { assessTransferRisk } from '@/core/transfer-risk/policy';
import { recordTransferAttempt } from '@/core/transfer-risk/records';
import type { TransferRiskContext } from '@/core/transfer-risk/types';

// Invariant failures carry a structured violation rather than a feature's string error code.
type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: E };
function err<E>(code: E): { readonly ok: false; readonly code: E } { return { ok: false, code }; }
import { DomainInvariantChecker } from './checker';
import type { DomainState, InvariantViolation, Ticket, TransferRecord } from './types';

export interface IssueTicketParams {
  readonly id: string;
  readonly eventId: string;
  readonly tierId: string;
  readonly ownerAddress: string;
  readonly priceStroops: number;
  readonly validFrom: number;
  readonly validUntil: number;
  readonly metadataHash?: string;
}

export interface TransferTicketParams {
  readonly id: string;
  readonly ticketId: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly priceStroops: number;
  readonly organizerFeeStroops: number;
  readonly protocolFeeStroops: number;
  readonly sellerProceedsStroops: number;
  readonly nonce: string;
  readonly timestamp?: number;
}

export interface RedeemTicketParams {
  readonly ticketId: string;
  readonly claimerAddress: string;
  readonly timestamp: number;
}

/**
 * Issues a new ticket ensuring capacity bounds, stroop precision, and blacklist constraints.
 */
export function issueTicket(
  state: DomainState,
  params: IssueTicketParams
): Result<DomainState, InvariantViolation> {
  const event = state.events.get(params.eventId);
  if (!event) {
    return err({
      invariantId: 'INV-10',
      name: 'Organizer Event Solvency & Capacity Conservation',
      severity: 'critical',
      entityId: params.eventId,
      entityType: 'event',
      message: `Cannot issue ticket for non-existent event '${params.eventId}'`
    });
  }

  // Check capacity (INV-01 / INV-10)
  if (event.issuedCount + 1 > event.totalCapacity) {
    return err({
      invariantId: 'INV-10',
      name: 'Organizer Event Solvency & Capacity Conservation',
      severity: 'critical',
      entityId: event.id,
      entityType: 'event',
      message: `Event '${event.id}' has reached maximum capacity (${event.totalCapacity})`
    });
  }

  // Check blacklist (INV-11)
  if (state.blacklistedAddresses.has(params.ownerAddress)) {
    return err({
      invariantId: 'INV-11',
      name: 'Blacklisted Principal Action Quarantine',
      severity: 'critical',
      entityId: params.id,
      entityType: 'ticket',
      message: `Cannot issue ticket to blacklisted address '${params.ownerAddress}'`
    });
  }

  // Check stroop precision (INV-07)
  if (!Number.isInteger(params.priceStroops) || params.priceStroops < 0) {
    return err({
      invariantId: 'INV-07',
      name: 'Stroop Precision & Positive Bounds',
      severity: 'critical',
      entityId: params.id,
      entityType: 'ticket',
      message: `Ticket price must be a non-negative integer Stroop amount`
    });
  }

  // Check timebounds (INV-08)
  if (params.validFrom > params.validUntil) {
    return err({
      invariantId: 'INV-08',
      name: 'Timebound Redemption Validity Window',
      severity: 'high',
      entityId: params.id,
      entityType: 'ticket',
      message: `validFrom (${params.validFrom}) cannot be greater than validUntil (${params.validUntil})`
    });
  }

  // Create new ticket
  const newTicket: Ticket = {
    id: params.id,
    eventId: params.eventId,
    tierId: params.tierId,
    ownerAddress: params.ownerAddress,
    priceStroops: params.priceStroops,
    status: 'issued',
    issuedAt: Date.now(),
    validFrom: params.validFrom,
    validUntil: params.validUntil,
    fraudFlag: false,
    nonce: 0,
    metadataHash: params.metadataHash ?? ''
  };

  const updatedTickets = new Map(state.tickets);
  updatedTickets.set(newTicket.id, newTicket);

  const updatedEvents = new Map(state.events);
  updatedEvents.set(event.id, {
    ...event,
    issuedCount: event.issuedCount + 1
  });

  const nextState: DomainState = {
    ...state,
    events: updatedEvents,
    tickets: updatedTickets
  };

  return ok(nextState);
}

/**
 * Transfers ticket ownership while verifying value conservation and replay protection.
 */
export function validateTicketTransfer(
  state: DomainState,
  params: TransferTicketParams
): Result<Ticket, InvariantViolation> {
  if (!params.id.trim() || params.id.length > 128 || !params.nonce.trim() || params.nonce.length > 128 || !params.fromAddress.trim() || !params.toAddress.trim() || params.fromAddress === params.toAddress ||
      [params.priceStroops, params.organizerFeeStroops, params.protocolFeeStroops, params.sellerProceedsStroops].some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
    return err({ invariantId: 'INV-07', name: 'Stroop Precision & Positive Bounds', severity: 'critical',
      entityId: params.id, entityType: 'transfer', message: 'Use a unique transfer ID and nonce, a different recipient, and non-negative safe integer fee amounts.' });
  }
  const ticket = state.tickets.get(params.ticketId);
  if (!ticket) {
    return err({
      invariantId: 'INV-02',
      name: 'Single Active Ownership',
      severity: 'critical',
      entityId: params.ticketId,
      entityType: 'ticket',
      message: `Ticket '${params.ticketId}' not found`
    });
  }

  // Verify sender ownership (INV-02)
  if (ticket.ownerAddress !== params.fromAddress) {
    return err({
      invariantId: 'INV-02',
      name: 'Single Active Ownership',
      severity: 'critical',
      entityId: ticket.id,
      entityType: 'ticket',
      message: `Transfer initiator '${params.fromAddress}' is not the current owner '${ticket.ownerAddress}'`
    });
  }

  // Verify transition eligibility (INV-03, INV-04)
  const transitionCheck = DomainInvariantChecker.canTransitionStatus(ticket.status, 'transferred');
  if (!transitionCheck.valid && transitionCheck.violation) {
    return err(transitionCheck.violation);
  }

  // Verify lock / fraud flag (INV-05)
  if (ticket.status === 'locked' || ticket.fraudFlag) {
    return err({
      invariantId: 'INV-05',
      name: 'Escrow / Fraud Lock Transfer Bar',
      severity: 'critical',
      entityId: ticket.id,
      entityType: 'ticket',
      message: `Ticket is locked or flagged for fraud and cannot be transferred`
    });
  }

  // Check blacklists (INV-11)
  if (state.blacklistedAddresses.has(params.fromAddress) || state.blacklistedAddresses.has(params.toAddress)) {
    return err({
      invariantId: 'INV-11',
      name: 'Blacklisted Principal Action Quarantine',
      severity: 'critical',
      entityId: ticket.id,
      entityType: 'ticket',
      message: `Transfer involves a blacklisted party and is quarantined`
    });
  }

  // Verify zero-sum fee split (INV-06)
  const sumOfSplits = params.organizerFeeStroops + params.protocolFeeStroops + params.sellerProceedsStroops;
  if (sumOfSplits !== params.priceStroops) {
    return err({
      invariantId: 'INV-06',
      name: 'Value Conservation & Zero-Sum Fee Split',
      severity: 'critical',
      entityId: params.id,
      entityType: 'transfer',
      message: `Fee splits (${sumOfSplits}) do not sum to total price (${params.priceStroops})`
    });
  }

  // Verify nonce replay (INV-09)
  if (state.processedNonces.has(params.nonce) || state.transfers.some((transfer) => transfer.id === params.id)) {
    return err({
      invariantId: 'INV-09',
      name: 'Nonce & Idempotency Replay Protection',
      severity: 'critical',
      entityId: params.id,
      entityType: 'transfer',
      message: `Replay detected: transfer nonce '${params.nonce}' has already been processed`
    });
  }

  return ok(ticket);
}

export function transferTicket(
  state: DomainState,
  params: TransferTicketParams,
  riskContext: TransferRiskContext = {}
): Result<DomainState, InvariantViolation> {
  const validation = validateTicketTransfer(state, params);
  if (!validation.ok) return validation;
  const ticket = validation.value;
  const context = { ...riskContext, now: riskContext.now ?? Date.now() };
  const assessment = assessTransferRisk(state, params, context);
  if (assessment.disposition !== 'allow') return err({
    invariantId: 'INV-05', name: 'Transfer risk review', severity: 'high',
    entityId: params.id, entityType: 'transfer', code: assessment.code,
    message: assessment.disposition === 'review'
      ? 'This transfer needs organizer review before it can continue.'
      : 'This transfer cannot continue. Contact the organizer for help.'
  });

  // Apply transfer atomically
  const updatedTicket: Ticket = {
    ...ticket,
    ownerAddress: params.toAddress,
    status: 'transferred',
    nonce: ticket.nonce + 1
  };

  const transferRecord: TransferRecord = {
    id: params.id,
    ticketId: params.ticketId,
    fromAddress: params.fromAddress,
    toAddress: params.toAddress,
    priceStroops: params.priceStroops,
    organizerFeeStroops: params.organizerFeeStroops,
    protocolFeeStroops: params.protocolFeeStroops,
    sellerProceedsStroops: params.sellerProceedsStroops,
    nonce: params.nonce,
    timestamp: context.now
  };

  const updatedTickets = new Map(state.tickets);
  updatedTickets.set(updatedTicket.id, updatedTicket);

  const updatedNonces = new Set(state.processedNonces);
  updatedNonces.add(params.nonce);

  const nextState: DomainState = {
    ...state,
    tickets: updatedTickets,
    transfers: [...state.transfers, transferRecord],
    processedNonces: updatedNonces
  };

  return ok(recordTransferAttempt(nextState, params, ticket.nonce, 'completed', assessment, context));
}

/**
 * Redeems a ticket at an event check-in gate with timebound and state validation.
 */
export function redeemTicket(
  state: DomainState,
  params: RedeemTicketParams
): Result<DomainState, InvariantViolation> {
  const ticket = state.tickets.get(params.ticketId);
  if (!ticket) {
    return err({
      invariantId: 'INV-02',
      name: 'Single Active Ownership',
      severity: 'critical',
      entityId: params.ticketId,
      entityType: 'ticket',
      message: `Ticket '${params.ticketId}' not found`
    });
  }

  // Verify claimer ownership (INV-02)
  if (ticket.ownerAddress !== params.claimerAddress) {
    return err({
      invariantId: 'INV-02',
      name: 'Single Active Ownership',
      severity: 'critical',
      entityId: ticket.id,
      entityType: 'ticket',
      message: `Claimer '${params.claimerAddress}' does not own ticket '${ticket.id}'`
    });
  }

  // Verify lifecycle transition (INV-03, INV-04)
  const transitionCheck = DomainInvariantChecker.canTransitionStatus(ticket.status, 'redeemed');
  if (!transitionCheck.valid && transitionCheck.violation) {
    return err(transitionCheck.violation);
  }

  // Verify lock & fraud (INV-05)
  if (ticket.status === 'locked' || ticket.fraudFlag) {
    return err({
      invariantId: 'INV-05',
      name: 'Escrow / Fraud Lock Transfer Bar',
      severity: 'critical',
      entityId: ticket.id,
      entityType: 'ticket',
      message: `Cannot redeem locked or fraud-flagged ticket`
    });
  }

  // Verify timebounds (INV-08)
  if (params.timestamp < ticket.validFrom || params.timestamp > ticket.validUntil) {
    return err({
      invariantId: 'INV-08',
      name: 'Timebound Redemption Validity Window',
      severity: 'high',
      entityId: ticket.id,
      entityType: 'ticket',
      message: `Redemption time (${params.timestamp}) is outside valid event window [${ticket.validFrom}, ${ticket.validUntil}]`
    });
  }

  const updatedTicket: Ticket = {
    ...ticket,
    status: 'redeemed'
  };

  const updatedTickets = new Map(state.tickets);
  updatedTickets.set(updatedTicket.id, updatedTicket);

  return ok({
    ...state,
    tickets: updatedTickets
  });
}

/**
 * 2-Step Safe Ownership Transfer: Initiates a pending ownership transfer proposal for a ticket.
 * Checks INV-02 (ownership), INV-05 (lock bar), and INV-11 (blacklists).
 */
export function initiateSafeTicketTransfer(
  state: DomainState,
  params: {
    readonly ticketId: string;
    readonly fromAddress: string;
    readonly toAddress: string;
    readonly expiresInMs?: number;
    readonly priceStroops?: number;
    readonly memo?: string;
    readonly idempotencyKey?: string;
    readonly correlationId?: string;
    readonly actor: { kind: "user" | "maintainer" | "service" | "contract"; id: string };
  },
  store: import("@/core/ownership/ownership").OwnershipTransferStore = defaultOwnershipStore
): Result<import("@/core/ownership/types").OwnershipTransferProposal, InvariantViolation> {
  const ticket = state.tickets.get(params.ticketId);
  if (!ticket) {
    return err({
      invariantId: "INV-02",
      name: "Single Active Ownership",
      severity: "critical",
      entityId: params.ticketId,
      entityType: "ticket",
      message: `Ticket '${params.ticketId}' not found`
    });
  }

  if (ticket.ownerAddress !== params.fromAddress) {
    return err({
      invariantId: "INV-02",
      name: "Single Active Ownership",
      severity: "critical",
      entityId: ticket.id,
      entityType: "ticket",
      message: `Transfer initiator '${params.fromAddress}' is not the current owner '${ticket.ownerAddress}'`
    });
  }

  if (ticket.status === "locked" || ticket.fraudFlag) {
    return err({
      invariantId: "INV-05",
      name: "Escrow / Fraud Lock Transfer Bar",
      severity: "critical",
      entityId: ticket.id,
      entityType: "ticket",
      message: "Ticket is locked or flagged for fraud and cannot be transferred"
    });
  }

  if (state.blacklistedAddresses.has(params.fromAddress) || state.blacklistedAddresses.has(params.toAddress)) {
    return err({
      invariantId: "INV-11",
      name: "Blacklisted Principal Action Quarantine",
      severity: "critical",
      entityId: ticket.id,
      entityType: "ticket",
      message: "Transfer involves a blacklisted party and is quarantined"
    });
  }

  const proposalResult = store.initiate({
    resourceId: params.ticketId,
    resourceType: "ticket",
    currentOwner: params.fromAddress,
    proposedOwner: params.toAddress,
    expiresInMs: params.expiresInMs,
    priceStroops: params.priceStroops,
    memo: params.memo,
    idempotencyKey: params.idempotencyKey,
    correlationId: params.correlationId,
    actor: params.actor
  });

  if (!proposalResult.ok) {
    return err({
      invariantId: "INV-02",
      name: "Single Active Ownership",
      severity: "high",
      entityId: ticket.id,
      entityType: "ticket",
      message: `Safe ownership transfer initiation rejected: ${proposalResult.code}`
    });
  }

  return ok(proposalResult.value);
}

/**
 * 2-Step Safe Ownership Transfer: Completes a pending ticket transfer upon recipient acceptance.
 * Atomically updates ticket owner, increments nonce, and records the transfer.
 */
export function acceptSafeTicketTransfer(
  state: DomainState,
  params: {
    readonly transferId: string;
    readonly transferRecordId: string;
    readonly organizerFeeStroops?: number;
    readonly protocolFeeStroops?: number;
    readonly sellerProceedsStroops?: number;
    readonly nonce: string;
    readonly actor: { kind: "user" | "maintainer" | "service" | "contract"; id: string };
    readonly now?: number | Date;
  },
  store: import("@/core/ownership/ownership").OwnershipTransferStore = defaultOwnershipStore,
  riskContext: TransferRiskContext = {}
): Result<{ state: DomainState; proposal: import("@/core/ownership/types").OwnershipTransferProposal }, InvariantViolation> {
  const proposal = store.getTransfer(params.transferId, params.now);
  if (!proposal || proposal.resourceType !== 'ticket' || proposal.status !== 'pending' ||
      (params.actor.kind !== 'maintainer' && params.actor.id.replace(/^account:/, '') !== proposal.proposedOwner.replace(/^account:/, ''))) {
    return err({ invariantId: 'INV-02', name: 'Single Active Ownership', severity: 'high',
      entityId: params.transferId, entityType: 'transfer', message: 'The pending transfer is unavailable or this actor cannot accept it.' });
  }
  const price = proposal.priceStroops ?? 0;
  const organizerFee = params.organizerFeeStroops ?? 0, protocolFee = params.protocolFeeStroops ?? 0;
  const now = params.now instanceof Date ? params.now.getTime() : params.now;
  // Validate ownership, lifecycle, replay, fee conservation and risk before settling the proposal.
  const transferred = transferTicket(state, {
    id: params.transferRecordId, ticketId: proposal.resourceId,
    fromAddress: proposal.currentOwner, toAddress: proposal.proposedOwner,
    priceStroops: price, organizerFeeStroops: organizerFee, protocolFeeStroops: protocolFee,
    sellerProceedsStroops: params.sellerProceedsStroops ?? price - organizerFee - protocolFee,
    nonce: params.nonce
  }, { ...riskContext, now: riskContext.now ?? now });
  if (!transferred.ok) return transferred;
  const accepted = store.accept({ transferId: params.transferId, actor: params.actor, now: params.now });
  if (!accepted.ok) return err({ invariantId: 'INV-02', name: 'Single Active Ownership', severity: 'high',
    entityId: params.transferId, entityType: 'transfer', message: 'The transfer proposal could not be accepted.' });
  return ok({ state: transferred.value, proposal: accepted.value });
}
