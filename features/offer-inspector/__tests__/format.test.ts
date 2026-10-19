import { expect, it } from "vitest";
import { formatPrice, reserveTotals } from "../lib/format";
it("keeps repeating rational prices exact", () => expect(formatPrice({ numerator: 1, denominator: 3 })).toBe("1/3"));
it("keeps reserve sums exact beyond Number precision", () => expect(reserveTotals([], "9007199254740993")).toEqual({ account: "0", sponsored: "0" }));
