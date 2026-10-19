import { StrKey } from "@stellar/stellar-sdk";
import { horizonUrl } from "@/core/horizon/client";
import { parseAmount } from "@/core/format/amount";
import { err, ok, type Result } from "@/core/result/result";
import type { StellarNetwork } from "@/core/network/types";
import { parseOfferInspectorInput } from "../schema";
import type { AccountOffer, OfferAsset, OfferInspectorInput, OfferInspectorResult, OfferInspectorErrorCode } from "../types";
import { requestJson, record, records, integer, InvalidResponse } from "./horizon";
import { toOfferInspectorErrorCode } from "./offerInspector.errors";

export const PAGE_SIZE = 50;

function asset(value: unknown): OfferAsset {
  const row = record(value);
  if (row.asset_type === "native") return { code: "XLM" };
  if ((row.asset_type !== "credit_alphanum4" && row.asset_type !== "credit_alphanum12") ||
      typeof row.asset_code !== "string" || !/^[a-zA-Z0-9]{1,12}$/.test(row.asset_code) ||
      typeof row.asset_issuer !== "string" || !StrKey.isValidEd25519PublicKey(row.asset_issuer)) throw new InvalidResponse();
  return { code: row.asset_code, issuer: row.asset_issuer };
}

function offer(value: unknown, accountId: string): AccountOffer {
  const row = record(value);
  const price = record(row.price_r);
  if (typeof row.id !== "string" || !/^\d{1,20}$/.test(row.id) ||
      row.seller !== accountId || typeof row.amount !== "string" || !parseAmount(row.amount).ok ||
      (row.sponsor !== undefined && (typeof row.sponsor !== "string" || !StrKey.isValidEd25519PublicKey(row.sponsor)))) throw new InvalidResponse();
  return { id: row.id, selling: asset(row.selling), buying: asset(row.buying), amount: row.amount,
    numerator: integer(price.n, 1, 2147483647), denominator: integer(price.d, 1, 2147483647), sponsor: row.sponsor as string | undefined };
}

export async function runOfferInspector(input: OfferInspectorInput, network: StellarNetwork, signal?: AbortSignal): Promise<Result<OfferInspectorResult, OfferInspectorErrorCode>> {
  const parsed = parseOfferInspectorInput(input);
  if (!parsed.ok) return parsed;
  const { accountId, cursor } = parsed.value;
  try {
    const [page, ledgers] = await Promise.all([
      requestJson(horizonUrl(network, `/accounts/${accountId}/offers`, { limit: PAGE_SIZE, order: "asc", cursor }), signal),
      requestJson(horizonUrl(network, "/ledgers", { limit: 1, order: "desc" }), signal)
    ]);
    const raw = records(page);
    if (raw.length > PAGE_SIZE) throw new InvalidResponse();
    const offers = raw.map((row) => offer(row, accountId));
    const tokens = raw.map((row) => record(row).paging_token);
    let previous = BigInt(cursor ?? "0");
    for (const token of tokens) {
      if (typeof token !== "string" || !/^\d{1,20}$/.test(token) || BigInt(token) <= previous) throw new InvalidResponse();
      previous = BigInt(token);
    }
    const base = record(records(ledgers)[0]).base_reserve_in_stroops;
    if ((typeof base !== "string" && typeof base !== "number") || !/^\d+$/.test(String(base)) || BigInt(base) <= 0n || (typeof base === "number" && !Number.isSafeInteger(base))) throw new InvalidResponse();
    return ok({ accountId, offers, cursor, baseReserveStroops: String(base), nextCursor: offers.length === PAGE_SIZE ? String(tokens.at(-1)) : null });
  } catch (error) { return err(toOfferInspectorErrorCode(error)); }
}
