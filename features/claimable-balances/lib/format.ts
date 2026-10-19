import { formatAmount } from "@/core/format/amount";
import { formatDateTime } from "@/core/format/date";
import type { ClaimableBalanceSummary } from "@/features/claimable-balances/types";

export { formatAmount, formatDateTime as formatTimestamp };

export function formatBalanceHeading(balance: ClaimableBalanceSummary): string {
  return `${formatAmount(balance.amount)} ${balance.asset.label}`;
}

export function formatClaimantStatus(claimableNow: boolean): string {
  return claimableNow ? "Claimable now" : "Not claimable now";
}
