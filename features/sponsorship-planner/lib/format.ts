import { formatAmount } from "@/core/format/amount";
/** Reserve results are stroop strings, not decimal XLM strings. */
export function formatReserve(stroops: string): string { return formatAmount(BigInt(stroops)); }
