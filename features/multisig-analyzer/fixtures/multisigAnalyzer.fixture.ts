import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, type Keypair as Key } from "@stellar/stellar-sdk";
const key = (byte: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, byte));
export const master = key(61), second = key(62), other = key(63), stranger = key(64);
export const accountId = master.publicKey(), secretSeed = stranger.secret();
export function makeTransaction(signers: Key[] = [master], operations = [Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: "1" })]) {
  const builder = new TransactionBuilder(new Account(accountId, "100"), { fee: "100", networkPassphrase: Networks.TESTNET });
  operations.forEach((operation) => builder.addOperation(operation));
  const tx = builder.setTimeout(0).build();
  if (signers.length) tx.sign(...signers);
  return tx;
}
export const rawInput = { accountId, xdr: makeTransaction([master, second]).toXDR() };
export const validInput = rawInput;
export function accountJson(id = accountId) {
  return { account_id: id, thresholds: { low_threshold: 1, med_threshold: 3, high_threshold: 5 }, signers: [
    { key: id, type: "ed25519_public_key", weight: 1 }, ...(id === accountId ? [{ key: second.publicKey(), type: "ed25519_public_key", weight: 2 }] : [])
  ] };
}
