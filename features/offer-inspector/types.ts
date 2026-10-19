export interface OfferInspectorRaw { accountId: string; cursor?: string }
export type OfferInspectorInput = OfferInspectorRaw;
export interface OfferAsset { code: string; issuer?: string }
export interface AccountOffer {
  id: string;
  selling: OfferAsset;
  buying: OfferAsset;
  amount: string;
  numerator: number;
  denominator: number;
  sponsor?: string;
}
export interface OfferInspectorResult {
  accountId: string;
  offers: AccountOffer[];
  baseReserveStroops: string;
  nextCursor: string | null;
  cursor?: string;
}
export type OfferInspectorErrorCode = "empty_input" | "invalid_address" | "secret_key" | "account_not_found" | "rate_limited" | "timeout" | "network_unavailable" | "invalid_response" | "request_failed" | "invalid_cursor";
