import { describe, expect, it } from "vitest";
import { parseOfferInspectorInput } from "../schema";
import { accountId, secretSeed } from "../fixtures/offerInspector.fixture";
describe("offer input", () => {
  it("trims the public address", () => expect(parseOfferInspectorInput({ accountId: ` ${accountId} ` })).toEqual({ ok: true, value: { accountId, cursor: undefined } }));
  it.each([["", "empty_input"], ["Sbad", "secret_key"], [secretSeed, "secret_key"], ["invalid", "invalid_address"]])("rejects invalid input", (value, code) => expect(parseOfferInspectorInput({ accountId: value })).toEqual({ ok: false, code }));
  it("does not accept an injected cursor URL", () => expect(parseOfferInspectorInput({ accountId, cursor: "https://evil.example" })).toEqual({ ok: false, code: "invalid_cursor" }));
  it("rejects an embedded secret before rendering or requests", () => expect(parseOfferInspectorInput({ accountId: `prefix${secretSeed}suffix` })).toEqual({ ok: false, code: "secret_key" }));
});
