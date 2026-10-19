import { Keypair } from "@stellar/stellar-sdk";
const key = (byte: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, byte));
export const accountId = key(41).publicKey(), issuer = key(42).publicKey(), sponsor = key(43).publicKey(), secretSeed = key(44).secret();
export const rawInput = { accountId };
export const validInput = rawInput;
export const ledgerJson = { _embedded: { records: [{ base_reserve_in_stroops: 5000000 }] } };
export function offerJson(id = "1", sponsored = false) {
  return { id, paging_token: id, seller: accountId, selling: { asset_type: "native" }, buying: { asset_type: "credit_alphanum4", asset_code: "USD", asset_issuer: issuer }, amount: "900719925.4740993", price: "0.3333333", price_r: { n: 1, d: 3 }, ...(sponsored ? { sponsor } : {}) };
}
export const offersJson = { _embedded: { records: [offerJson(), offerJson("2", true)] } };
