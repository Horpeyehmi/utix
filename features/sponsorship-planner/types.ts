export const ENTRY_KINDS = ["trustlines", "poolTrustlines", "offers", "signers", "dataEntries"] as const;
export type EntryKind = typeof ENTRY_KINDS[number];
export interface SponsorshipPlannerRaw {
  sponsor: string; accountId: string;
  counts: Record<EntryKind, string>;
  sponsored: Record<EntryKind, boolean>;
  sponsorAccount: boolean;
}
export interface SponsorshipPlannerInput extends Omit<SponsorshipPlannerRaw, "counts"> { counts: Record<EntryKind, number> }
export interface ReserveAccount {
  accountId: string; balance: bigint; sellingLiabilities: bigint;
  subentries: number; sponsoring: number; sponsored: number;
}
export interface SponsorshipPlannerResult {
  sponsor: string; accountId: string; newAccount: boolean;
  baseReserveStroops: string;
  entries: { kind: EntryKind; count: number; units: number; sponsored: boolean }[];
  sponsoredUnits: number;
  sponsorCostStroops: string; sponsorMinimumStroops: string; sponsorAvailableStroops: string; sponsorShortfallStroops: string;
  accountMinimumStroops: string; accountShortfallStroops: string;
}
export type SponsorshipPlannerErrorCode = "empty_input" | "invalid_address" | "secret_key" | "account_not_found" | "rate_limited" | "timeout" | "network_unavailable" | "invalid_response" | "request_failed" | "same_account" | "invalid_count" | "existing_account_base";
