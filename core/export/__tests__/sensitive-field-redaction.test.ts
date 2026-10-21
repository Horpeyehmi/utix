/**
 * Permission-aware export with sensitive-field redaction (#314).
 *
 * Verifies that `applyFieldLevelAuthorization` and `evaluateFieldAuthorization`
 * correctly omit or mask each class of sensitive field based on actor kind and
 * explicit permission grants, covering the normal path, failure path, and the
 * boundary between "omit" and "mask" behaviours.
 */

import { describe, expect, it } from "vitest";
import {
  applyFieldLevelAuthorization,
  evaluateFieldAuthorization,
  DEFAULT_SENSITIVE_FIELD_RULES,
  type ExportActor,
} from "../exporter";

const userActor: ExportActor = { kind: "user" };
const maintainerActor: ExportActor = { kind: "maintainer" };

const record = {
  id: "op-001",
  amount: "100.00",
  status: "settled",
  // maintainer-only fields
  ipAddress: "203.0.113.10",
  userAgent: "Mozilla/5.0",
  internalLatencyMs: 42,
  adminNotes: "flagged for review",
  riskScore: 0.85,
  debugTrace: '{"step":"auth","ok":true}',
  traceId: "trace-abc123",
  rawPayload: '{"raw":true}',
  systemSignature: "sig-xyz",
  nodeId: "node-7",
  sessionToken: "tok-secret",
};

describe("sensitive-field redaction (#314)", () => {
  describe("user actor — omit/mask behaviour", () => {
    it("strips all maintainer-only fields for a plain user actor", () => {
      const { record: out, filteredCount } = applyFieldLevelAuthorization(
        record,
        userActor,
        { rules: DEFAULT_SENSITIVE_FIELD_RULES }
      );

      // Non-sensitive fields must survive
      expect(out.id).toBe("op-001");
      expect(out.amount).toBe("100.00");
      expect(out.status).toBe("settled");

      // Every maintainer-only field must be absent or masked
      expect(out.internalLatencyMs).toBeUndefined();
      expect(out.userAgent).toBeUndefined();
      expect(out.debugTrace).toBeUndefined();
      expect(out.traceId).toBeUndefined();
      expect(out.rawPayload).toBeUndefined();
      expect(out.systemSignature).toBeUndefined();
      expect(out.nodeId).toBeUndefined();
      expect(out.sessionToken).toBeUndefined();
      expect(out.adminNotes).toBe("[FILTERED: UNAUTHORIZED]"); // onDenied: "mask"
      expect(filteredCount).toBeGreaterThanOrEqual(9);
    });

    it("masks ipAddress (onDenied: mask) instead of omitting it", () => {
      const { record: out } = applyFieldLevelAuthorization(
        { ipAddress: "192.0.2.1" },
        userActor,
        { rules: DEFAULT_SENSITIVE_FIELD_RULES }
      );
      expect(out.ipAddress).toBe("[FILTERED: UNAUTHORIZED]");
    });

    it("omits riskScore (onDenied: omit) from user output", () => {
      const { record: out } = applyFieldLevelAuthorization(
        { riskScore: 0.9 },
        userActor,
        { rules: DEFAULT_SENSITIVE_FIELD_RULES }
      );
      expect(out.riskScore).toBeUndefined();
    });
  });

  describe("maintainer actor — full access", () => {
    it("passes all fields through unchanged for a maintainer", () => {
      const { record: out, filteredCount } = applyFieldLevelAuthorization(
        record,
        maintainerActor,
        { rules: DEFAULT_SENSITIVE_FIELD_RULES }
      );

      expect(out.ipAddress).toBe(record.ipAddress);
      expect(out.adminNotes).toBe(record.adminNotes);
      expect(out.riskScore).toBe(record.riskScore);
      expect(out.debugTrace).toBe(record.debugTrace);
      expect(filteredCount).toBe(0);
    });
  });

  describe("evaluateFieldAuthorization — explicit field request", () => {
    it("denies a user explicitly requesting a maintainer-only field", () => {
      const result = evaluateFieldAuthorization(
        userActor,
        ["id", "amount", "riskScore"],
        DEFAULT_SENSITIVE_FIELD_RULES
      );
      expect(result.authorized).toBe(false);
      expect(result.deniedFields).toContain("riskScore");
    });

    it("allows a user requesting only safe fields", () => {
      const result = evaluateFieldAuthorization(
        userActor,
        ["id", "amount", "status"],
        DEFAULT_SENSITIVE_FIELD_RULES
      );
      expect(result.authorized).toBe(true);
      expect(result.deniedFields).toHaveLength(0);
    });

    it("grants a maintainer access to any explicitly requested field", () => {
      const result = evaluateFieldAuthorization(
        maintainerActor,
        ["riskScore", "debugTrace", "sessionToken"],
        DEFAULT_SENSITIVE_FIELD_RULES
      );
      expect(result.authorized).toBe(true);
      expect(result.deniedFields).toHaveLength(0);
    });
  });

  describe("field projection intersection", () => {
    it("returns only the requested projection fields even when authorized", () => {
      const { record: out } = applyFieldLevelAuthorization(
        record,
        maintainerActor,
        {
          requestedFields: ["id", "amount"],
          rules: DEFAULT_SENSITIVE_FIELD_RULES,
        }
      );
      expect(Object.keys(out)).toEqual(["id", "amount"]);
    });

    it("does not leak a sensitive field when projection and deny rule both apply", () => {
      // User requests both a safe field and a sensitive one in the projection
      const { record: out } = applyFieldLevelAuthorization(
        record,
        userActor,
        {
          requestedFields: ["id", "riskScore"],
          rules: DEFAULT_SENSITIVE_FIELD_RULES,
        }
      );
      expect(out.id).toBe("op-001");
      expect(out.riskScore).toBeUndefined();
    });
  });
});
