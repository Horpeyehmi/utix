import { expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createOwnershipStore } from "@/core/ownership/ownership";
import { acceptSafeTicketTransfer } from "@/core/invariants/mutations";
import type { DomainState, Ticket } from "@/core/invariants/types";

const owner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 71)).publicKey();
const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 72)).publicKey();
const NOW = 1_800_000_000_000;

function setup() {
  const ticket: Ticket = { id: "ticket", eventId: "event", tierId: "general", ownerAddress: owner, priceStroops: 100,
    status: "issued", issuedAt: NOW - 1000, validFrom: NOW, validUntil: NOW + 86_400_000, fraudFlag: false, nonce: 0, metadataHash: "" };
  const state: DomainState = { tickets: new Map([[ticket.id, ticket]]),
    events: new Map([["event", { id: "event", organizerAddress: "organizer", issuedCount: 1, totalCapacity: 10, status: "active", feeBasisPoints: 0 }]]),
    transfers: [], processedNonces: new Set(), blacklistedAddresses: new Set() };
  const store = createOwnershipStore();
  const proposal = store.initiate({ resourceId: ticket.id, resourceType: "ticket", currentOwner: owner,
    proposedOwner: recipient, priceStroops: 100, actor: { kind: "user", id: owner }, now: NOW });
  if (!proposal.ok) throw new Error(proposal.code);
  const params = { transferId: proposal.value.id, transferRecordId: "record", nonce: "nonce", actor: { kind: "user" as const, id: recipient }, now: NOW };
  return { state, store, params };
}

it("refuses risky safe acceptance while leaving the proposal pending", () => {
  const { state, store, params } = setup();
  const previous = { id: "previous", ticketId: "ticket", fromAddress: "previous", toAddress: owner,
    nonce: "previous", priceStroops: 100, organizerFeeStroops: 0, protocolFeeStroops: 0, sellerProceedsStroops: 100, timestamp: NOW - 1000 };
  const result = acceptSafeTicketTransfer({ ...state, transfers: [previous] }, params, store);
  expect(!result.ok && result.code.code).toBe("transfer_review_required");
  expect(store.getTransfer(params.transferId, NOW)?.status).toBe("pending");
  expect(state.tickets.get("ticket")?.ownerAddress).toBe(owner);
});

it("validates ownership and fee conservation before settling a proposal", () => {
  const { state, store, params } = setup();
  const invalidFee = acceptSafeTicketTransfer(state, { ...params, organizerFeeStroops: 120, sellerProceedsStroops: 0 }, store);
  expect(invalidFee.ok).toBe(false);
  expect(store.getTransfer(params.transferId, NOW)?.status).toBe("pending");
  const ticket = state.tickets.get("ticket")!;
  const stale = { ...state, tickets: new Map([[ticket.id, { ...ticket, ownerAddress: recipient }]]) };
  expect(acceptSafeTicketTransfer(stale, params, store).ok).toBe(false);
  expect(store.getTransfer(params.transferId, NOW)?.status).toBe("pending");
});

it("applies the same gate to a normal recipient acceptance", () => {
  const { state, store, params } = setup();
  const result = acceptSafeTicketTransfer(state, params, store);
  expect(result.ok && result.value.proposal.status).toBe("accepted");
  expect(result.ok && result.value.state.tickets.get("ticket")?.ownerAddress).toBe(recipient);
  expect(result.ok && result.value.state.transferRisk?.attempts[0].status).toBe("completed");
});
