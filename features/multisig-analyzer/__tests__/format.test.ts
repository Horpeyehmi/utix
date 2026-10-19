import { expect, it } from "vitest";
import { checkLabel } from "../lib/format";
import { copy } from "../copy";
it("identifies operation positions and source checks", () => {
  const row = { kind: "operation" as const, operation: 2, operationType: "payment", accountId: "", level: "medium" as const, required: 1, present: 0, missing: 1, signers: [] };
  expect(checkLabel(row)).toBe(copy.operation(2, "payment"));
  expect(checkLabel({ ...row, kind: "fee" })).toBe(copy.fee);
});
