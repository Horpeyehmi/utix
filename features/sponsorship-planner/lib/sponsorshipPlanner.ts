import { horizonUrl } from "@/core/horizon/client";
import { responseStatusOf } from "@/core/horizon/errors";
import { parseAmount } from "@/core/format/amount";
import { err, ok, type Result } from "@/core/result/result";
import type { StellarNetwork } from "@/core/network/types";
import { parseSponsorshipPlannerInput } from "../schema";
import { ENTRY_KINDS, type ReserveAccount, type SponsorshipPlannerInput, type SponsorshipPlannerResult, type SponsorshipPlannerErrorCode } from "../types";
import { requestJson, record, records, integer, InvalidResponse } from "./horizon";
import { toSponsorshipPlannerErrorCode } from "./sponsorshipPlanner.errors";

function amount(value: unknown): bigint {
  if (typeof value !== "string") throw new InvalidResponse();
  const parsed = parseAmount(value);
  if (!parsed.ok) throw new InvalidResponse();
  return parsed.value;
}
export function normalizeAccount(value: unknown, accountId: string): ReserveAccount {
  const row = record(value);
  if (row.account_id !== accountId || !Array.isArray(row.balances)) throw new InvalidResponse();
  const native = record(row.balances.find((balance) => record(balance).asset_type === "native"));
  const subentries = integer(row.subentry_count), sponsored = integer(row.num_sponsored), sponsoring = integer(row.num_sponsoring);
  if (sponsored > 2 + subentries) throw new InvalidResponse();
  return { accountId, subentries, sponsored, sponsoring, balance: amount(native.balance), sellingLiabilities: amount(native.selling_liabilities) };
}
function minimum(account: ReserveAccount, base: bigint): bigint {
  return (2n + BigInt(account.subentries) + BigInt(account.sponsoring) - BigInt(account.sponsored)) * base;
}
const positive = (value: bigint) => value > 0n ? value : 0n;

export function calculatePlan(input: SponsorshipPlannerInput, sponsor: ReserveAccount, account: ReserveAccount | null, base: bigint): SponsorshipPlannerResult {
  const entries = ENTRY_KINDS.map((kind) => ({ kind, count: input.counts[kind], units: input.counts[kind] * (kind === "poolTrustlines" ? 2 : 1), sponsored: input.sponsored[kind] }));
  const total = entries.reduce((sum, entry) => sum + entry.units, 0);
  const sponsoredUnits = entries.reduce((sum, entry) => sum + (entry.sponsored ? entry.units : 0), !account && input.sponsorAccount ? 2 : 0);
  const cost = BigInt(sponsoredUnits) * base;
  const sponsorMinimum = minimum(sponsor, base) + cost;
  const available = sponsor.balance - sponsor.sellingLiabilities - sponsorMinimum;
  const accountMinimum = (account ? minimum(account, base) : 2n * base) + BigInt(total - sponsoredUnits) * base;
  const accountBalance = account?.balance ?? 0n, accountLiabilities = account?.sellingLiabilities ?? 0n;
  return {
    sponsor: input.sponsor, accountId: input.accountId, newAccount: !account,
    baseReserveStroops: base.toString(), entries, sponsoredUnits,
    sponsorCostStroops: cost.toString(), sponsorMinimumStroops: sponsorMinimum.toString(), sponsorAvailableStroops: available.toString(), sponsorShortfallStroops: positive(-available).toString(),
    accountMinimumStroops: accountMinimum.toString(), accountShortfallStroops: positive(accountMinimum + accountLiabilities - accountBalance).toString()
  };
}

export async function runSponsorshipPlanner(input: SponsorshipPlannerInput, network: StellarNetwork, signal?: AbortSignal): Promise<Result<SponsorshipPlannerResult, SponsorshipPlannerErrorCode>> {
  // Revalidate at the request boundary as callers other than the form can invoke this function.
  const parsed = parseSponsorshipPlannerInput({ ...input, counts: Object.fromEntries(ENTRY_KINDS.map((kind) => [kind, String(input.counts[kind])])) as Record<typeof ENTRY_KINDS[number], string> });
  if (!parsed.ok) return parsed;
  try {
    const [sponsorJson, accountJson, ledgers] = await Promise.all([
      requestJson(horizonUrl(network, `/accounts/${input.sponsor}`), signal),
      requestJson(horizonUrl(network, `/accounts/${input.accountId}`), signal).catch((error: unknown) => { if (responseStatusOf(error) === 404) return null; throw error; }),
      requestJson(horizonUrl(network, "/ledgers", { order: "desc", limit: 1 }), signal)
    ]);
    const sponsor = normalizeAccount(sponsorJson, input.sponsor);
    const account = accountJson === null ? null : normalizeAccount(accountJson, input.accountId);
    if (account && input.sponsorAccount) return err("existing_account_base");
    const reserve = record(records(ledgers)[0]).base_reserve_in_stroops;
    if ((typeof reserve !== "string" && typeof reserve !== "number") || !/^\d+$/.test(String(reserve)) || BigInt(reserve) <= 0n || (typeof reserve === "number" && !Number.isSafeInteger(reserve))) throw new InvalidResponse();
    return ok(calculatePlan(parsed.value, sponsor, account, BigInt(reserve)));
  } catch (error) { return err(toSponsorshipPlannerErrorCode(error)); }
}
