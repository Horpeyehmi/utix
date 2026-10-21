/**
 * Deterministic recovery tests for interrupted multi-step operations (#313).
 *
 * Covers the failure paths where a multi-step operation (transfer, redemption)
 * is left mid-flight after a rollback or a process crash. Each test exercises
 * a concrete interrupted state: pending transfer from a rolled-back version,
 * stale in-flight transfer, and partially confirmed redemption.
 */

import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  verifyPendingOperationsAndInFlightTransfers,
  verifyPartiallyProcessedRedemptions,
  type ProtocolDataset,
  type RollbackTarget,
} from "../rollback-verifier";

const ALICE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0xaa)).publicKey();
const BOB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0xbb)).publicKey();

const TARGET: RollbackTarget = {
  targetVersion: "1.0.0",
  rolledBackFromVersion: "2.0.0",
};

const NOW = 1_770_000_000_000;

function emptyDataset(overrides: Partial<ProtocolDataset> = {}): ProtocolDataset {
  return {
    events: [],
    tickets: [],
    transfers: [],
    redemptions: [],
    workerJobs: [],
    ...overrides,
  };
}

describe("interrupted multi-step operations — recovery tests (#313)", () => {
  describe("pending transfer interrupted by rollback", () => {
    it("flags a pending transfer whose version matches the rolled-back release", () => {
      const dataset = emptyDataset({
        transfers: [
          {
            id: "xfer-interrupted-001",
            ticketId: "ticket-1",
            fromOwner: ALICE,
            toOwner: BOB,
            status: "pending",
            protocolVersion: "2.0.0", // the rolled-back version
            initiatedAt: NOW - 60_000,
            expiresAt: NOW + 3_600_000,
          },
        ],
      });

      const { check, repairs } = verifyPendingOperationsAndInFlightTransfers(
        dataset,
        TARGET,
        { now: () => new Date(NOW) }
      );

      expect(check.passed).toBe(false);
      expect(check.severity).toBe("critical");
      expect(repairs).toHaveLength(1);
      expect(repairs[0].recordId).toBe("xfer-interrupted-001");
      expect(repairs[0].severity).toBe("critical");
    });

    it("flags a stale pending transfer that exceeded the max age window", () => {
      const dataset = emptyDataset({
        transfers: [
          {
            id: "xfer-stale-001",
            ticketId: "ticket-2",
            fromOwner: ALICE,
            toOwner: BOB,
            status: "pending",
            protocolVersion: "1.0.0", // current version — not a rollback victim
            initiatedAt: NOW - 25 * 60 * 60 * 1_000, // 25 hours ago
            expiresAt: NOW + 3_600_000,
          },
        ],
      });

      const { check, repairs } = verifyPendingOperationsAndInFlightTransfers(
        dataset,
        TARGET,
        { now: () => new Date(NOW) }
      );

      expect(check.passed).toBe(false);
      expect(repairs[0].severity).toBe("warning");
    });

    it("passes when all transfers are settled or cancelled", () => {
      const dataset = emptyDataset({
        transfers: [
          {
            id: "xfer-ok-001",
            ticketId: "ticket-3",
            fromOwner: ALICE,
            toOwner: BOB,
            status: "accepted",
            protocolVersion: "2.0.0",
            initiatedAt: NOW - 60_000,
            expiresAt: NOW + 3_600_000,
            settledAt: NOW - 30_000,
          },
        ],
      });

      const { check } = verifyPendingOperationsAndInFlightTransfers(dataset, TARGET, {
        now: () => new Date(NOW),
      });

      expect(check.passed).toBe(true);
    });
  });

  describe("partially confirmed redemption interrupted mid-step", () => {
    it("flags an unconfirmed redemption from a rolled-back version", () => {
      const dataset = emptyDataset({
        redemptions: [
          {
            id: "redemption-interrupted-001",
            ticketId: "ticket-4",
            eventId: "event-1",
            redeemedBy: ALICE,
            nonce: "nonce-abc",
            protocolVersion: "2.0.0",
            redeemedAt: NOW - 30_000,
            isConfirmed: false, // check-in recorded but not confirmed — interrupted
          },
        ],
      });

      const { check, repairs } = verifyPartiallyProcessedRedemptions(dataset, TARGET);

      expect(check.passed).toBe(false);
      expect(repairs.length).toBeGreaterThanOrEqual(1);
      expect(repairs[0].domain).toBe("redemption");
    });

    it("passes for a fully confirmed redemption even on a rolled-back version", () => {
      const dataset = emptyDataset({
        redemptions: [
          {
            id: "redemption-confirmed-001",
            ticketId: "ticket-5",
            eventId: "event-1",
            redeemedBy: ALICE,
            nonce: "nonce-def",
            protocolVersion: "2.0.0",
            redeemedAt: NOW - 60_000,
            isConfirmed: true,
          },
        ],
      });

      const { check } = verifyPartiallyProcessedRedemptions(dataset, TARGET);

      expect(check.passed).toBe(true);
    });
  });
});
