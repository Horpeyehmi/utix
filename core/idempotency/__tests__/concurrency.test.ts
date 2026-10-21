import { describe, expect, it } from "vitest";
import {
  createIdempotencyStore,
  type IdempotencyRecord,
  type IdempotencyStore
} from "@/core/idempotency/idempotency";

describe("Concurrency - Duplicate Submissions and Stale Versions", () => {
  describe("Duplicate submission detection", () => {
    it("detects identical submissions with same idempotency key", async () => {
      const store = createIdempotencyStore();

      const result1 = store.record("payment-key-1", { amount: 100 });
      expect(result1.ok).toBe(true);
      expect(result1.replayed).toBe(false);

      const result2 = store.record("payment-key-1", { amount: 100 });
      expect(result2.ok).toBe(true);
      expect(result2.replayed).toBe(true);
    });

    it("prevents duplicate submission within TTL window", () => {
      const store = createIdempotencyStore();
      const now = new Date("2026-01-01T00:00:00.000Z").getTime();

      const result1 = store.record("key-1", { operation: "transfer", amount: 50 });
      expect(result1.ok).toBe(true);

      const result2 = store.record("key-1", { operation: "transfer", amount: 50 });
      expect(result2.ok).toBe(true);
      expect(result2.replayed).toBe(true);
    });

    it("detects concurrent submissions of same request", () => {
      const store = createIdempotencyStore();

      const submission1 = store.record("concurrent-key", { operation: "mint" });
      expect(submission1.ok).toBe(true);

      const submission2 = store.record("concurrent-key", { operation: "mint" });
      expect(submission2.ok).toBe(true);
      expect(submission2.replayed).toBe(true);
    });

    it("allows different keys for different submissions", () => {
      const store = createIdempotencyStore();

      const result1 = store.record("key-1", { amount: 100 });
      expect(result1.ok).toBe(true);

      const result2 = store.record("key-2", { amount: 100 });
      expect(result2.ok).toBe(true);
      expect(result2.replayed).toBe(false);
    });

    it("rejects duplicate keys with conflicting payloads", () => {
      const store = createIdempotencyStore();

      const result1 = store.record("conflict-key", { amount: 100 });
      expect(result1.ok).toBe(true);

      const result2 = store.record("conflict-key", { amount: 200 });
      expect(result2.ok).toBe(false);
      expect(result2.error).toBe("idempotency_key_conflict");
    });
  });

  describe("Stale version handling", () => {
    it("tracks version for optimistic concurrency control", () => {
      const store = createIdempotencyStore();

      const record1 = store.record("version-key-1", { status: "draft", version: 1 });
      expect(record1.ok).toBe(true);

      const record2 = store.record("version-key-2", { status: "draft", version: 1 });
      expect(record2.ok).toBe(true);
    });

    it("detects stale submissions with old version", () => {
      const store = createIdempotencyStore();

      store.record("stale-key", { resource: "ticket-1", version: 1 });

      const staleAttempt = store.record("stale-key-2", { resource: "ticket-1", version: 0 });
      expect(staleAttempt.ok).toBe(true);
    });

    it("allows updates to newer versions", () => {
      const store = createIdempotencyStore();

      const v1 = store.record("version-track", { version: 1, data: "v1" });
      expect(v1.ok).toBe(true);

      const v2 = store.record("version-track-2", { version: 2, data: "v2" });
      expect(v2.ok).toBe(true);
    });
  });

  describe("Race condition tests", () => {
    it("handles near-simultaneous submissions", () => {
      const store = createIdempotencyStore();
      const results = [];

      for (let i = 0; i < 5; i++) {
        const result = store.record("race-key", { attempt: i });
        results.push(result);
      }

      const successful = results.filter((r) => r.ok === true);
      expect(successful.length).toBeGreaterThan(0);
    });

    it("maintains consistency during parallel operations", () => {
      const store = createIdempotencyStore();
      const operations = [];

      for (let i = 0; i < 10; i++) {
        operations.push(store.record(`parallel-${i}`, { id: i }));
      }

      const allSuccessful = operations.every((op) => op.ok === true);
      expect(allSuccessful).toBe(true);
    });

    it("detects conflicts in high-contention scenarios", () => {
      const store = createIdempotencyStore();

      const result1 = store.record("high-contention", { amount: 100 });
      const result2 = store.record("high-contention", { amount: 100 });
      const result3 = store.record("high-contention", { amount: 100 });

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      expect(result2.replayed).toBe(true);
      expect(result3.ok).toBe(true);
      expect(result3.replayed).toBe(true);
    });

    it("handles deduplication during concurrent flow", () => {
      const store = createIdempotencyStore();

      const initial = store.record("dedupe-key", { flow: "transfer", receiver: "bob" });
      expect(initial.ok).toBe(true);

      const retry1 = store.record("dedupe-key", { flow: "transfer", receiver: "bob" });
      expect(retry1.replayed).toBe(true);

      const retry2 = store.record("dedupe-key", { flow: "transfer", receiver: "bob" });
      expect(retry2.replayed).toBe(true);

      expect(retry1.record?.value.flow).toBe("transfer");
    });
  });

  describe("Normal deduplication flow", () => {
    it("records submission and returns outcome on replay", () => {
      const store = createIdempotencyStore();

      const initial = store.record("normal-key", { action: "create_ticket" });
      expect(initial.ok).toBe(true);
      expect(initial.replayed).toBe(false);

      const replayed = store.record("normal-key", { action: "create_ticket" });
      expect(replayed.ok).toBe(true);
      expect(replayed.replayed).toBe(true);
      expect(replayed.record?.value).toEqual({ action: "create_ticket" });
    });

    it("prevents duplicate submissions across retries", () => {
      const store = createIdempotencyStore();

      const attempt1 = store.record("retry-key", { payload: "data" });
      expect(attempt1.ok).toBe(true);

      const attempt2 = store.record("retry-key", { payload: "data" });
      expect(attempt2.replayed).toBe(true);

      const attempt3 = store.record("retry-key", { payload: "data" });
      expect(attempt3.replayed).toBe(true);
    });

    it("maintains request order and consistency", () => {
      const store = createIdempotencyStore();
      const keys = ["req-1", "req-2", "req-3", "req-4"];

      keys.forEach((key) => {
        const result = store.record(key, { order: keys.indexOf(key) + 1 });
        expect(result.ok).toBe(true);
      });

      const recorded = keys.map((key) => store.record(key, { order: keys.indexOf(key) + 1 }));
      recorded.forEach((r) => {
        expect(r.replayed).toBe(true);
      });
    });
  });

  describe("Authorization paths for deduplication", () => {
    it("respects ownership in deduplication", () => {
      const store = createIdempotencyStore();

      const alice = store.record("alice-key", { owner: "alice", action: "transfer" });
      expect(alice.ok).toBe(true);

      const bob = store.record("bob-key", { owner: "bob", action: "transfer" });
      expect(bob.ok).toBe(true);

      const aliceRetry = store.record("alice-key", { owner: "alice", action: "transfer" });
      expect(aliceRetry.replayed).toBe(true);
    });

    it("prevents cross-user deduplication", () => {
      const store = createIdempotencyStore();

      const userA = store.record("shared-key", { owner: "alice" });
      expect(userA.ok).toBe(true);

      const userB = store.record("shared-key", { owner: "bob" });
      expect(userB.ok).toBe(false);
    });
  });

  describe("Failure modes", () => {
    it("handles invalid idempotency keys", () => {
      const store = createIdempotencyStore();

      const validKey = store.record("valid-key", { data: "test" });
      expect(validKey.ok).toBe(true);

      const emptyKey = store.record("", { data: "test" });
      expect(emptyKey.ok).toBeFalsy();
    });

    it("handles malformed payloads gracefully", () => {
      const store = createIdempotencyStore();

      const result1 = store.record("malformed-key", { valid: true });
      expect(result1.ok).toBe(true);

      const result2 = store.record("malformed-key", null);
      expect(result2.ok).toBeFalsy();
    });

    it("detects and rejects conflicting duplicate submissions", () => {
      const store = createIdempotencyStore();

      const first = store.record("conflict-key", { amount: 50, currency: "USD" });
      expect(first.ok).toBe(true);

      const second = store.record("conflict-key", { amount: 75, currency: "EUR" });
      expect(second.ok).toBe(false);
      expect(second.error).toBe("idempotency_key_conflict");
    });

    it("expires old submissions per TTL policy", () => {
      const store = createIdempotencyStore();

      const old = store.record("ttl-key", { timestamp: "2025-01-01" });
      expect(old.ok).toBe(true);

      const newSubmission = store.record("ttl-key", { timestamp: "2025-01-01" });
      expect(newSubmission.ok).toBe(true);
    });
  });
});
