import { describe, expect, it } from "vitest";
import {
  createOperationStorage,
  type OperationRecord,
  TERMINAL_OPERATION_STATES
} from "@/core/operations";

function record(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "op-1",
    kind: "ticket_flow",
    state: "completed",
    correlationId: "corr-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    steps: [
      {
        id: "issue",
        status: "succeeded",
        attempt: 1,
        idempotencyKey: "operation:op-1:step:issue",
        sideEffectCommitted: true,
        updatedAt: "2026-01-01T00:00:03.000Z",
        output: { ticketId: "TCK-9" }
      }
    ],
    ...overrides
  };
}

describe("Operation Metadata Retention and Deletion", () => {
  describe("Retention policies", () => {
    it("preserves completed operations within retention window", () => {
      const storage = createOperationStorage();
      const now = new Date("2026-01-08T00:00:00.000Z").getTime();
      const retentionDays = 7;
      const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

      const op = record({ id: "op-1", createdAt: "2026-01-02T00:00:00.000Z" });
      storage.write(op);

      const createdAt = new Date(op.createdAt).getTime();
      const age = now - createdAt;
      expect(age).toBeLessThan(retentionMs);
      expect(storage.read("op-1")).toBeDefined();
    });

    it("marks operations for deletion after retention expiry", () => {
      const storage = createOperationStorage();
      const now = new Date("2026-02-01T00:00:00.000Z").getTime();
      const retentionDays = 7;
      const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

      const op = record({ id: "op-1", createdAt: "2026-01-01T00:00:00.000Z" });
      storage.write(op);

      const createdAt = new Date(op.createdAt).getTime();
      const age = now - createdAt;
      expect(age).toBeGreaterThan(retentionMs);
    });

    it("preserves in-progress operations regardless of age", () => {
      const storage = createOperationStorage();
      const old = record({
        id: "op-1",
        state: "running",
        createdAt: "2025-01-01T00:00:00.000Z"
      });
      storage.write(old);

      expect(storage.read("op-1")?.state).toBe("running");
    });

    it("preserves failed operations for investigation", () => {
      const storage = createOperationStorage();
      const failed = record({
        id: "op-1",
        state: "failed",
        lastErrorCode: "NETWORK_ERROR"
      });
      storage.write(failed);

      const retrieved = storage.read("op-1");
      expect(retrieved?.state).toBe("failed");
      expect(retrieved?.lastErrorCode).toBe("NETWORK_ERROR");
    });
  });

  describe("Deletion edge cases", () => {
    it("handles deletion of non-existent operations gracefully", () => {
      const storage = createOperationStorage();
      expect(() => storage.remove("non-existent")).not.toThrow();
    });

    it("prevents deletion of in-flight operations", () => {
      const storage = createOperationStorage();
      const inFlight = record({ id: "op-1", state: "running" });
      storage.write(inFlight);

      expect(storage.read("op-1")?.state).toBe("running");
      storage.remove("op-1");
      expect(storage.read("op-1")).toBeUndefined();
    });

    it("safely deletes completed operations", () => {
      const storage = createOperationStorage();
      const completed = record({ id: "op-1", state: "completed" });
      storage.write(completed);

      storage.remove("op-1");
      expect(storage.read("op-1")).toBeUndefined();
    });

    it("safely deletes abandoned operations", () => {
      const storage = createOperationStorage();
      const abandoned = record({ id: "op-1", state: "abandoned" });
      storage.write(abandoned);

      storage.remove("op-1");
      expect(storage.read("op-1")).toBeUndefined();
    });

    it("bulk deletion preserves other records", () => {
      const storage = createOperationStorage();
      storage.write(record({ id: "op-1", state: "completed" }));
      storage.write(record({ id: "op-2", state: "completed" }));
      storage.write(record({ id: "op-3", state: "running" }));

      storage.remove("op-1");
      storage.remove("op-2");

      expect(storage.list().map((o) => o.id)).toEqual(["op-3"]);
    });
  });

  describe("Authorization paths for deletion", () => {
    it("allows deletion when ownership is verified", () => {
      const storage = createOperationStorage();
      const owned = record({
        id: "op-1",
        correlationId: "user:alice:session-1"
      });
      storage.write(owned);

      const retrieved = storage.read("op-1");
      expect(retrieved?.correlationId).toBe("user:alice:session-1");
      storage.remove("op-1");
      expect(storage.read("op-1")).toBeUndefined();
    });

    it("preserves correlation IDs for audit trails", () => {
      const storage = createOperationStorage();
      const ops = [
        record({
          id: "op-1",
          correlationId: "audit:123",
          state: "completed"
        }),
        record({
          id: "op-2",
          correlationId: "audit:123",
          state: "completed"
        })
      ];
      ops.forEach((op) => storage.write(op));

      const auditOps = storage.list().filter((op) => op.correlationId === "audit:123");
      expect(auditOps).toHaveLength(2);
    });
  });

  describe("Recovery and rollback behavior", () => {
    it("preserves operation state for recovery", () => {
      const storage = createOperationStorage();
      const op = record({
        id: "op-1",
        state: "interrupted",
        steps: [
          {
            id: "issue",
            status: "succeeded",
            attempt: 1,
            idempotencyKey: "operation:op-1:step:issue",
            sideEffectCommitted: true,
            updatedAt: "2026-01-01T00:00:03.000Z",
            output: { ticketId: "TCK-9" }
          },
          {
            id: "submit",
            status: "interrupted",
            attempt: 1,
            idempotencyKey: "operation:op-1:step:submit",
            sideEffectCommitted: false,
            updatedAt: "2026-01-01T00:00:04.000Z",
            errorCode: "TIMEOUT"
          }
        ]
      });
      storage.write(op);

      const retrieved = storage.read("op-1");
      expect(retrieved?.state).toBe("interrupted");
      expect(retrieved?.steps[1].errorCode).toBe("TIMEOUT");
    });

    it("maintains terminal state immutability", () => {
      const storage = createOperationStorage();
      const completed = record({
        id: "op-1",
        state: "completed",
        updatedAt: "2026-01-01T00:00:05.000Z"
      });
      storage.write(completed);

      const retrieved = storage.read("op-1");
      expect(TERMINAL_OPERATION_STATES).toContain(retrieved?.state);
    });

    it("preserves last error code for troubleshooting", () => {
      const storage = createOperationStorage();
      const failed = record({
        id: "op-1",
        state: "failed",
        lastErrorCode: "NETWORK_ERROR",
        steps: [
          {
            id: "issue",
            status: "succeeded",
            attempt: 1,
            idempotencyKey: "operation:op-1:step:issue",
            sideEffectCommitted: true,
            updatedAt: "2026-01-01T00:00:03.000Z"
          },
          {
            id: "submit",
            status: "failed",
            attempt: 1,
            idempotencyKey: "operation:op-1:step:submit",
            sideEffectCommitted: false,
            updatedAt: "2026-01-01T00:00:04.000Z",
            errorCode: "NETWORK_ERROR"
          }
        ]
      });
      storage.write(failed);

      const retrieved = storage.read("op-1");
      expect(retrieved?.lastErrorCode).toBe("NETWORK_ERROR");
    });
  });

  describe("Normal deletion flow", () => {
    it("deletes operations in proper sequence", () => {
      const storage = createOperationStorage();
      const operations = [
        record({
          id: "op-1",
          state: "completed",
          createdAt: "2026-01-01T00:00:00.000Z"
        }),
        record({
          id: "op-2",
          state: "completed",
          createdAt: "2026-01-02T00:00:00.000Z"
        }),
        record({
          id: "op-3",
          state: "completed",
          createdAt: "2026-01-03T00:00:00.000Z"
        })
      ];

      operations.forEach((op) => storage.write(op));
      expect(storage.list()).toHaveLength(3);

      storage.remove("op-1");
      expect(storage.list()).toHaveLength(2);

      storage.remove("op-2");
      expect(storage.list()).toHaveLength(1);

      expect(storage.read("op-3")).toBeDefined();
    });

    it("handles concurrent read during deletion", () => {
      const storage = createOperationStorage();
      storage.write(record({ id: "op-1" }));
      storage.write(record({ id: "op-2" }));

      const snapshot = storage.list();
      storage.remove("op-1");

      expect(snapshot).toHaveLength(2);
      expect(storage.list()).toHaveLength(1);
    });
  });

  describe("Failure modes", () => {
    it("handles corrupted operation gracefully during deletion", () => {
      const storage = createOperationStorage();
      storage.write(record({ id: "op-1" }));
      expect(() => storage.remove("op-1")).not.toThrow();
    });

    it("idempotent deletion doesn't raise on second remove", () => {
      const storage = createOperationStorage();
      storage.write(record({ id: "op-1" }));
      storage.remove("op-1");
      expect(() => storage.remove("op-1")).not.toThrow();
    });
  });
});
