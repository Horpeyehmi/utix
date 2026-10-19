import { expect, it } from "vitest";
import { formatReserve } from "../lib/format";
it("does not lose the last stroop", () => expect(formatReserve("9007199254740993").replaceAll(",", "")).toBe("900719925.4740993"));
it("preserves a sponsor deficit sign", () => expect(formatReserve("-5000000")).toBe("-0.5"));
