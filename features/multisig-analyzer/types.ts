export interface MultisigAnalyzerRaw { accountId: string; xdr: string }
export type MultisigAnalyzerInput = MultisigAnalyzerRaw;
export type ThresholdLevel = "low" | "medium" | "high";
export interface VerifiedSigner { key: string; weight: number; present: boolean; signatureIndex?: number }
export interface AuthorizationCheck {
  kind: "transaction" | "operation" | "fee" | "extra";
  operation?: number; operationType?: string;
  accountId: string; level: ThresholdLevel;
  required: number; present: number; missing: number;
  signers: VerifiedSigner[];
}
export interface MultisigAnalyzerResult {
  accountId: string; transactionHash: string; feeBump: boolean;
  checks: AuthorizationCheck[];
  unusedInnerSignatures: number[]; unusedOuterSignatures: number[];
  authorizationSatisfied: boolean;
}
export type MultisigAnalyzerErrorCode = "empty_input" | "invalid_address" | "secret_key" | "account_not_found" | "rate_limited" | "timeout" | "network_unavailable" | "invalid_response" | "request_failed" | "invalid_xdr" | "input_too_large" | "source_mismatch" | "unsupported_operation";
