import { formatAmount } from "@/core/format/amount";
import type { AccountOffer } from "../types";

/** Keep the exact rational price: repeating prices must not be rounded away. */
export function formatPrice(offer: Pick<AccountOffer, "numerator" | "denominator">): string {
  return `${offer.numerator}/${offer.denominator}`;
}
export function reserveTotals(offers: AccountOffer[], baseReserveStroops: string) {
  const sponsored = offers.filter((offer) => offer.sponsor !== undefined).length;
  return { account: formatAmount(BigInt(offers.length - sponsored) * BigInt(baseReserveStroops)),
    sponsored: formatAmount(BigInt(sponsored) * BigInt(baseReserveStroops)) };
}
