import { Keypair } from "@stellar/stellar-sdk";
import type { SponsorshipPlannerRaw, SponsorshipPlannerInput } from "../types";
const key = (byte: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, byte));
export const accountId = key(51).publicKey(), sponsor = key(52).publicKey(), secretSeed = key(53).secret();
export const rawInput: SponsorshipPlannerRaw = { sponsor, accountId,
  counts: { trustlines: "2", poolTrustlines: "1", offers: "1", signers: "0", dataEntries: "0" },
  sponsored: { trustlines: true, poolTrustlines: true, offers: false, signers: true, dataEntries: true }, sponsorAccount: false };
export const validInput: SponsorshipPlannerInput = { ...rawInput, counts: { trustlines: 2, poolTrustlines: 1, offers: 1, signers: 0, dataEntries: 0 } };
export const ledgerJson = { _embedded: { records: [{ base_reserve_in_stroops: 5000000 }] } };
export function accountJson(id: string, balance = "20.0000000", selling = "3.0000000") {
  return { account_id: id, subentry_count: 3, num_sponsoring: 2, num_sponsored: 1, balances: [{ asset_type: "native", balance, selling_liabilities: selling }] };
}
