import { describe, expect, it } from "vitest";
import { Account, Asset, MuxedAccount, Networks, Operation, SignerKey, StrKey, TransactionBuilder, xdr, hash } from "@stellar/stellar-sdk";
import { withMswHandlers, http, HttpResponse } from "@/core/testing/msw";
import { runMultisigAnalyzer, operationThreshold } from "../lib/multisigAnalyzer";
import { handlers } from "../msw/handlers";
import { accountId, accountJson, master, second, other, stranger, makeTransaction } from "../fixtures/multisigAnalyzer.fixture";
const server = withMswHandlers(...handlers);
const endpoint = `https://horizon-testnet.stellar.org/accounts/${accountId}`;
const run = (tx: { toXDR(): string }) => runMultisigAnalyzer({ accountId, xdr: tx.toXDR() }, "testnet");
describe("cryptographic multisig analysis", () => {
  it("reports the exact shortfall and remaining signer candidates", async () => {
    const result = await run(makeTransaction());
    if (!result.ok) throw new Error(result.code);
    expect(result.value.checks[1]).toMatchObject({ required: 3, present: 1, missing: 2 });
    expect(result.value.checks[1].signers.find((signer) => signer.key === second.publicKey())).toMatchObject({ present: false, weight: 2 });
  });
  it("satisfies the operation with two valid signers", async () => {
    const result = await run(makeTransaction([master, second]));
    expect(result.ok && result.value.authorizationSatisfied).toBe(true);
  });
  it("requires every extra signer precondition", async () => {
    const tx = new TransactionBuilder(new Account(accountId, "100"), { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: "1" }))
      .setExtraSigners([stranger.publicKey()]).setTimeout(0).build();
    tx.sign(master, second);
    const missing = await run(tx);
    expect(missing.ok && missing.value.checks.find((row) => row.kind === "extra")).toMatchObject({ missing: 1 });
    tx.sign(stranger);
    const complete = await run(tx);
    expect(complete.ok && complete.value.authorizationSatisfied).toBe(true);
  });
  it("resolves a muxed source to the correct base account", async () => {
    const tx = new TransactionBuilder(new MuxedAccount(new Account(accountId, "100"), "42"), { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: "1" }))
      .setTimeout(0).build();
    tx.sign(master, second);
    const result = await run(tx);
    expect(result.ok && result.value.authorizationSatisfied).toBe(true);
    expect(result.ok && result.value.accountId).toBe(accountId);
  });
  it("checks high and medium setOptions variants, including zero values", () => {
    const medium = makeTransaction([], [Operation.setOptions({ homeDomain: "example.org" })]).operations[0];
    const high = makeTransaction([], [Operation.setOptions({ masterWeight: 0 })]).operations[0];
    expect(operationThreshold(medium)).toBe("medium"); expect(operationThreshold(high)).toBe("high");
    expect(operationThreshold(makeTransaction([], [Operation.inflation({})]).operations[0])).toBe("low");
  });
  it("does not count duplicate signatures twice", async () => {
    const tx = makeTransaction(); tx.sign(master);
    const result = await run(tx);
    expect(result.ok && result.value.checks[1].present).toBe(1);
    expect(result.ok && result.value.unusedInnerSignatures).toEqual([2]);
  });
  it("does not trust a matching hint with an invalid signature", async () => {
    const tx = makeTransaction([]);
    tx.addDecoratedSignature(new xdr.DecoratedSignature({ hint: master.signatureHint(), signature: stranger.sign(tx.hash()) }));
    const result = await run(tx);
    expect(result.ok && result.value.checks[0].present).toBe(0);
  });
  it("verifies against the selected network passphrase", async () => {
    const result = await runMultisigAnalyzer({ accountId, xdr: makeTransaction([master, second]).toXDR() }, "mainnet");
    expect(result.ok && result.value.checks[1].present).toBe(0);
  });
  it("requires a positive-weight signature even with zero thresholds", async () => {
    server.use(http.get(endpoint, () => HttpResponse.json({ ...accountJson(), thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 }, signers: [{ key: accountId, weight: 0 }] })));
    const result = await run(makeTransaction());
    expect(result.ok && result.value.checks[0]).toMatchObject({ required: 1, present: 0, missing: 1 });
  });
  it("checks every operation source independently", async () => {
    const tx = makeTransaction([master, second], [Operation.payment({ source: other.publicKey(), destination: accountId, asset: Asset.native(), amount: "1" })]);
    const result = await run(tx);
    expect(result.ok && result.value.checks[1]).toMatchObject({ accountId: other.publicKey(), present: 0, missing: 3 });
  });
  it("checks fee-bump signatures in a separate envelope domain", async () => {
    const inner = makeTransaction([master, second]);
    const outer = TransactionBuilder.buildFeeBumpTransaction(other.publicKey(), "200", inner, Networks.TESTNET);
    const missing = await run(outer);
    expect(missing.ok && missing.value.checks.at(-1)).toMatchObject({ kind: "fee", missing: 1 });
    outer.sign(other);
    const present = await run(outer);
    expect(present.ok && present.value.authorizationSatisfied).toBe(true);
  });
  it("counts a preauthorized hash without an envelope signature", async () => {
    const tx = makeTransaction([]);
    server.use(http.get(endpoint, () => HttpResponse.json({ ...accountJson(), signers: [{ key: StrKey.encodePreAuthTx(tx.hash()), weight: 5 }] })));
    const result = await run(tx);
    expect(result.ok && result.value.authorizationSatisfied).toBe(true);
  });
  it("verifies hash-preimage signers", async () => {
    const tx = makeTransaction([]), preimage = Buffer.from("deterministic-preimage"); tx.signHashX(preimage);
    server.use(http.get(endpoint, () => HttpResponse.json({ ...accountJson(), signers: [{ key: StrKey.encodeSha256Hash(Buffer.from(hash(preimage))), weight: 5 }] })));
    const result = await run(tx);
    expect(result.ok && result.value.authorizationSatisfied).toBe(true);
  });
  it("verifies signed payloads and their decorated hints", async () => {
    const tx = makeTransaction([]), payload = Buffer.from("payload");
    tx.addDecoratedSignature(master.signPayloadDecorated(payload));
    const key = SignerKey.encodeSignerKey(xdr.SignerKey.signerKeyTypeEd25519SignedPayload(new xdr.SignerKeyEd25519SignedPayload({ ed25519: master.rawPublicKey(), payload })));
    server.use(http.get(endpoint, () => HttpResponse.json({ ...accountJson(), signers: [{ key, weight: 5 }] })));
    const result = await run(tx);
    expect(result.ok && result.value.authorizationSatisfied).toBe(true);
  });
  it("rejects an address that does not match the inner source", async () => expect(await runMultisigAnalyzer({ accountId: other.publicKey(), xdr: makeTransaction().toXDR() }, "testnet")).toEqual({ ok: false, code: "source_mismatch" }));
  it("maps missing accounts and invalid Horizon weights safely", async () => {
    server.use(http.get(endpoint, () => HttpResponse.json({}, { status: 404 })));
    expect(await run(makeTransaction())).toEqual({ ok: false, code: "account_not_found" });
    server.use(http.get(endpoint, () => HttpResponse.json({ ...accountJson(), signers: [{ key: accountId, weight: -1 }] })));
    expect(await run(makeTransaction())).toEqual({ ok: false, code: "invalid_response" });
  });
});
