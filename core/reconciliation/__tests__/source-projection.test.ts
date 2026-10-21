/**
 * Reconciliation checks for source state and cached projections (#315).
 *
 * Verifies that `reconcile` detects the specific class of drift that arises
 * when a cached projection disagrees with its source of truth — a stored
 * balance that does not match the current ledger entry, or a balance that
 * exists in the cache but has no corresponding ledger record at all.
 *
 * These are the two scenarios an operator sees after a cache warm-up failure
 * or a missed ledger close: the projection says one thing, the source says
 * another.
 */

import { describe, expect, it } from "vitest";
import {
  reconcile,
  amountsEqual,
  type ReconciliationInput,
  type StoredBalance,
  type LedgerBalance,
} from "@/core/reconciliation/reconciliation";

const NOW = 1_770_000_000_000;

function snap(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    storedBalances: [],
    ledgerBalances: [],
    jobs: [],
    notifications: [],
    idempotencyRecords: [],
    exportEnvelopes: [],
    operations: [],
    now: NOW,
    ...overrides,
  };
}

describe("source state vs cached projection reconciliation (#315)", () => {
  describe("missing ledger entry", () => {
    it("flags a stored balance that has no matching ledger entry", () => {
      const stored: StoredBalance = {
        account: "GABC",
        asset: "USDC:GAAA",
        balance: "100.00",
        cachedAt: new Date(NOW - 30_000).toISOString(),
      };

      const report = reconcile(snap({ storedBalances: [stored], ledgerBalances: [] }));

      const missing = report.results.find((r) => r.invariant === "balance.ledger_entry_present");
      expect(missing).toBeDefined();
      expect(missing!.findings).toBeGreaterThanOrEqual(1);
      expect(report.totalFindings).toBeGreaterThanOrEqual(1);
    });

    it("passes when every stored balance has a matching ledger entry", () => {
      const account = "GABC";
      const asset = "USDC:GAAA";
      const stored: StoredBalance = { account, asset, balance: "50.00" };
      const ledger: LedgerBalance = { account, asset, balance: "50.00", reference: "ledger-close-1" };

      const report = reconcile(snap({ storedBalances: [stored], ledgerBalances: [ledger] }));

      const missing = report.results.find((r) => r.invariant === "balance.ledger_entry_present");
      expect(missing?.findings ?? 0).toBe(0);
      expect(report.passed).toBe(true);
    });
  });

  describe("amount disagreement between cached projection and source", () => {
    it("flags a stored balance that differs from the ledger amount", () => {
      const account = "GDEF";
      const asset = "XLM:native";
      const stored: StoredBalance = {
        account,
        asset,
        balance: "200.00",
        cachedAt: new Date(NOW - 5_000).toISOString(),
      };
      const ledger: LedgerBalance = {
        account,
        asset,
        balance: "195.50", // ledger closed with a different amount
        reference: "ledger-close-2",
      };

      const report = reconcile(snap({ storedBalances: [stored], ledgerBalances: [ledger] }));

      const inconsistent = report.results.find((r) => r.invariant === "balance.amount_agrees");
      expect(inconsistent).toBeDefined();
      expect(inconsistent!.findings).toBeGreaterThanOrEqual(1);
    });

    it("passes when cached and ledger amounts are equal", () => {
      const account = "GDEF";
      const asset = "XLM:native";
      const stored: StoredBalance = { account, asset, balance: "195.50" };
      const ledger: LedgerBalance = { account, asset, balance: "195.50", reference: "ledger-close-3" };

      const report = reconcile(snap({ storedBalances: [stored], ledgerBalances: [ledger] }));

      const inconsistent = report.results.find((r) => r.invariant === "balance.amount_agrees");
      expect(inconsistent?.findings ?? 0).toBe(0);
    });
  });

  describe("duplicate cached projection lines", () => {
    it("flags two stored lines for the same account and asset", () => {
      const account = "GHIJ";
      const asset = "USDC:GAAA";
      const stored: StoredBalance[] = [
        { account, asset, balance: "10.00" },
        { account, asset, balance: "10.00" },
      ];
      const ledger: LedgerBalance = { account, asset, balance: "10.00", reference: "lc-4" };

      const report = reconcile(
        snap({ storedBalances: stored, ledgerBalances: [ledger] })
      );

      const dup = report.results.find((r) => r.invariant === "balance.single_line_per_asset");
      expect(dup).toBeDefined();
      expect(dup!.findings).toBeGreaterThanOrEqual(1);
    });
  });

  describe("amountsEqual helper", () => {
    it("treats numerically equal decimal strings as equal", () => {
      expect(amountsEqual("1.00", "1.0")).toBe(true);
      expect(amountsEqual("100", "100.00")).toBe(true);
    });

    it("distinguishes genuinely different amounts", () => {
      expect(amountsEqual("100.00", "100.01")).toBe(false);
    });
  });
});
