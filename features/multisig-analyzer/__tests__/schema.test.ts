import { describe, expect, it } from "vitest";
import { parseMultisigAnalyzerInput } from "../schema";
import { rawInput, secretSeed } from "../fixtures/multisigAnalyzer.fixture";
describe("multisig input", () => {
  it("accepts an envelope with surrounding whitespace", () => expect(parseMultisigAnalyzerInput({ ...rawInput, xdr: `\n${rawInput.xdr}\n` })).toEqual({ ok: true, value: rawInput }));
  it("rejects a secret embedded in envelope text", () => expect(parseMultisigAnalyzerInput({ ...rawInput, xdr: `prefix${secretSeed}suffix` })).toEqual({ ok: false, code: "secret_key" }));
  it("bounds XDR size before decoding", () => expect(parseMultisigAnalyzerInput({ ...rawInput, xdr: "A".repeat(200004) })).toEqual({ ok: false, code: "input_too_large" }));
  it("rejects non-base64 input", () => expect(parseMultisigAnalyzerInput({ ...rawInput, xdr: "not an envelope!" })).toEqual({ ok: false, code: "invalid_xdr" }));
});
