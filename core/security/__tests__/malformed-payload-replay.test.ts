/**
 * Fixtures for malformed payload and replay attack scenarios (#316).
 *
 * Two threat families covered:
 *
 * 1. Malformed payloads — inputs that deviate from the expected format at the
 *    parser boundary (null bytes, truncated data, wrong encoding, oversized,
 *    control characters, Unicode trick-strings). Each fixture exercises a
 *    specific property of the parser's sanitization surface.
 *
 * 2. Replay attacks — the same high-risk write submitted more than once under
 *    the same idempotency key, a different key with a conflicting request hash,
 *    or a key whose TTL has elapsed. The idempotency module is the single
 *    enforcement point; these fixtures prove it handles each replay sub-class
 *    correctly.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  evaluateXdrBombScenario,
  evaluateSecretCustodyScenario,
  evaluateSep007UriScenario,
  MAX_XDR_PAYLOAD_BYTES,
  MAX_XDR_RECURSION_DEPTH,
} from "../threat-model";
import {
  createIdempotencyStore,
  isValidIdempotencyKey,
  requestDigest,
  withIdempotency,
} from "@/core/idempotency/idempotency";
import { ok, err } from "@/core/result/result";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStore(ttlMs = 60_000) {
  let clock = 1_770_000_000_000;
  const store = createIdempotencyStore({
    ttlMs,
    now: () => clock,
    newId: () => "idem-" + clock,
  });
  return { store, advance: (ms: number) => { clock += ms; } };
}

// ─── Malformed Payload Fixtures ───────────────────────────────────────────────

describe("Malformed payload fixtures", () => {
  describe("XDR boundary", () => {
    it("rejects a payload at exactly one byte above the limit", () => {
      const payload = "A".repeat(MAX_XDR_PAYLOAD_BYTES + 1);
      const result = evaluateXdrBombScenario(payload, 1);
      expect(result.passed).toBe(true);
      expect(result.threatSeverity).toBe("critical");
      expect(result.details).toMatchObject({ maxAllowed: MAX_XDR_PAYLOAD_BYTES });
    });

    it("accepts a payload at exactly the limit", () => {
      // Exactly MAX_XDR_PAYLOAD_BYTES ASCII chars → exactly MAX bytes in utf-8
      const payload = "A".repeat(MAX_XDR_PAYLOAD_BYTES);
      const result = evaluateXdrBombScenario(payload, 1);
      expect(result.threatSeverity).toBe("low");
    });

    it("rejects recursion depth exactly one above the ceiling", () => {
      const result = evaluateXdrBombScenario("AAAA", MAX_XDR_RECURSION_DEPTH + 1);
      expect(result.passed).toBe(true);
      expect(result.threatSeverity).toBe("high");
      expect(result.details).toMatchObject({ maxDepth: MAX_XDR_RECURSION_DEPTH });
    });

    it("accepts recursion at exactly the ceiling", () => {
      const result = evaluateXdrBombScenario("AAAA", MAX_XDR_RECURSION_DEPTH);
      expect(result.threatSeverity).toBe("low");
    });

    it("flags invalid base64 characters (null byte injected)", () => {
      const payload = "AAAA\x00BBBB";
      const result = evaluateXdrBombScenario(payload, 1);
      expect(result.passed).toBe(true);
      expect(result.mitigationApplied).toContain("Strict base64 character set validation");
    });

    it("flags invalid base64 characters (control characters)", () => {
      const payload = "AAAA\t\r\nBBBB";
      const result = evaluateXdrBombScenario(payload, 1);
      expect(result.passed).toBe(true);
      expect(result.mitigationApplied).toContain("Strict base64 character set validation");
    });

    it("flags Unicode confusable characters in XDR payload", () => {
      // U+FF21 is FULLWIDTH LATIN CAPITAL LETTER A — looks like 'A' but is not ASCII
      const payload = "ＡＢＣＤ";
      const result = evaluateXdrBombScenario(payload, 1);
      expect(result.passed).toBe(true);
      expect(result.mitigationApplied).toContain("Strict base64 character set validation");
    });

    it("handles empty string without throwing", () => {
      const result = evaluateXdrBombScenario("", 0);
      expect(result.passed).toBe(true);
    });

    it("handles whitespace-only string as malformed base64", () => {
      const result = evaluateXdrBombScenario("   ", 1);
      // After trim: empty string — the base64 regex skips the check, treated as benign
      expect(result.passed).toBe(true);
    });
  });

  describe("SEP-0007 URI boundary", () => {
    it("blocks data: URI carrying base64 payload (script injection vector)", () => {
      const result = evaluateSep007UriScenario("data:text/html,<script>alert(1)</script>");
      expect(result.passed).toBe(true);
      expect(result.threatSeverity).toBe("critical");
    });

    it("blocks vbscript: URI (legacy ActiveX execution vector)", () => {
      const result = evaluateSep007UriScenario("vbscript:MsgBox(1)");
      expect(result.passed).toBe(true);
      expect(result.threatSeverity).toBe("critical");
    });

    it("rejects empty URI without throwing", () => {
      const result = evaluateSep007UriScenario("");
      expect(result.passed).toBe(true);
    });

    it("flags malformed destination key embedded in SEP-0007 URI", () => {
      const result = evaluateSep007UriScenario(
        "web+stellar:pay?destination=NOT_A_KEY&amount=10&asset_code=USDC"
      );
      expect(result.passed).toBe(true);
      expect(result.threatSeverity).toBe("high");
      expect(result.mitigationApplied).toContain("Malformed destination account key");
    });
  });

  describe("Secret custody boundary", () => {
    it("intercepts secret key embedded in a JSON memo field", () => {
      const result = evaluateSecretCustodyScenario({
        memo: "payment for SA7TWFMFZPRQKLICYQST7N9Z3NVX2KAHUPCWDQ2XKIJBNXFAZF57LXFG",
      });
      expect(result.passed).toBe(true);
      expect(result.threatSeverity).toBe("critical");
      expect(result.details).toMatchObject({ secretDetectedCount: 1 });
    });

    it("intercepts multiple secret keys in a bulk object", () => {
      const result = evaluateSecretCustodyScenario({
        keys: [
          "SA7TWFMFZPRQKLICYQST7N9Z3NVX2KAHUPCWDQ2XKIJBNXFAZF57LXFG",
          "SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        ],
      });
      expect(result.passed).toBe(true);
      expect(result.threatSeverity).toBe("critical");
      expect((result.details.secretDetectedCount as number)).toBeGreaterThanOrEqual(1);
    });

    it("accepts a payload with a public key only (no secret)", () => {
      const result = evaluateSecretCustodyScenario({
        address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      });
      expect(result.passed).toBe(true);
      expect(result.threatSeverity).toBe("low");
    });
  });
});

// ─── Replay Attack Fixtures ───────────────────────────────────────────────────

describe("Replay attack fixtures", () => {
  describe("idempotency key validation", () => {
    it("rejects keys that are empty strings", () => {
      expect(isValidIdempotencyKey("")).toBe(false);
    });

    it("rejects keys that are too short (< 8 chars)", () => {
      expect(isValidIdempotencyKey("abc")).toBe(false);
    });

    it("accepts a valid UUID-shaped key", () => {
      expect(isValidIdempotencyKey("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    });
  });

  describe("duplicate submission replay", () => {
    it("replays a completed outcome and does not re-execute the handler", async () => {
      const { store } = makeStore();
      let calls = 0;
      const run = () => { calls++; return ok({ done: true }); };

      const first = await withIdempotency(store, {
        key: "replay-fixture-001",
        operation: "export.generate",
        request: { page: 1 },
        run,
      });
      const second = await withIdempotency(store, {
        key: "replay-fixture-001",
        operation: "export.generate",
        request: { page: 1 },
        run,
      });

      expect(first.ok && first.value.replayed).toBe(false);
      expect(second.ok && second.value.replayed).toBe(true);
      expect(calls).toBe(1);
    });

    it("replays a recorded failure without re-running the operation", async () => {
      const { store } = makeStore();
      let calls = 0;
      const run = () => { calls++; return err("horizon_timeout" as const); };

      await withIdempotency(store, { key: "replay-fail-001", operation: "worker.run", run });
      const second = await withIdempotency(store, { key: "replay-fail-001", operation: "worker.run", run });

      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error).toBe("horizon_timeout");
      }
      expect(calls).toBe(1);
    });
  });

  describe("request hash conflict (mutated payload replay)", () => {
    it("rejects a second request with the same key but a different payload", async () => {
      const { store } = makeStore();

      await withIdempotency(store, {
        key: "conflict-key-001",
        operation: "export.generate",
        request: { page: 1 },
        run: () => ok({ done: true }),
      });

      const second = await withIdempotency(store, {
        key: "conflict-key-001",
        operation: "export.generate",
        request: { page: 2 }, // different payload — same key
        run: () => ok({ done: true }),
      });

      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error).toBe("idempotency_key_conflict");
      }
    });

    it("requestDigest produces different hashes for different payloads", () => {
      const h1 = requestDigest({ page: 1 });
      const h2 = requestDigest({ page: 2 });
      expect(h1).not.toBe(h2);
    });

    it("requestDigest is stable for the same payload regardless of key order", () => {
      const h1 = requestDigest({ b: 2, a: 1 });
      const h2 = requestDigest({ a: 1, b: 2 });
      expect(h1).toBe(h2);
    });
  });

  describe("expired key replay", () => {
    it("rejects a key that has elapsed its TTL", async () => {
      const { store, advance } = makeStore(5_000); // 5s TTL

      await withIdempotency(store, {
        key: "expired-key-001",
        operation: "export.generate",
        request: {},
        run: () => ok({ done: true }),
      });

      advance(6_000); // past TTL

      const second = await withIdempotency(store, {
        key: "expired-key-001",
        operation: "export.generate",
        request: {},
        run: () => ok({ done: true }),
      });

      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error).toBe("idempotency_key_expired");
      }
    });

    it("accepts the same key again just before TTL elapses", async () => {
      const { store, advance } = makeStore(5_000);

      await withIdempotency(store, {
        key: "almost-expired-001",
        operation: "export.generate",
        request: {},
        run: () => ok({ done: true }),
      });

      advance(4_999); // one ms before expiry

      const second = await withIdempotency(store, {
        key: "almost-expired-001",
        operation: "export.generate",
        request: {},
        run: () => ok({ done: true }),
      });

      // Still within TTL — should replay, not error
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.replayed).toBe(true);
      }
    });
  });
});
