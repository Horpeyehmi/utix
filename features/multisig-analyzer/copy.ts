import type { MultisigAnalyzerErrorCode } from "./types";
export const copy = {
  account: "Transaction source public address", accountHint: "Use the base G address of the inner transaction source.",
  envelope: "Transaction envelope XDR", envelopeHint: "Paste a base64 envelope. Signature verification stays in your browser; only public account addresses are sent to Horizon.",
  submit: "Analyze signatures", loading: "Checking source accounts and signatures…",
  emptyTitle: "Find the signature weight still missing", emptyDescription: "Paste an envelope and its source public address. Each operation is checked against its own source account and threshold on the selected network.",
  resultTitle: "Signature analysis", satisfied: "Envelope signature requirements satisfied", missing: "Envelope signature requirements not satisfied",
  transaction: "Transaction source", fee: "Fee-bump source", extra: "Extra signer precondition", operation: (index: number, type: string) => `Operation ${index}: ${type}`,
  levels: { low: "Low", medium: "Medium", high: "High" },
  required: "Required weight", present: "Verified weight available", shortfall: "Weight still missing", level: "Threshold", source: "Source account",
  signerCaption: "Signer contributions for this authorization check", signer: "Signer key", weight: "Weight", status: "Signature", verified: "Verified", absent: "Missing", disabled: "Disabled",
  candidates: "Positive-weight signers without a verified contribution are candidates for the missing weight. Any combination meeting the shortfall can authorize this check.",
  unusedInner: "Unused inner signature positions", unusedOuter: "Unused outer signature positions", unusedNote: "Unused signatures can cause tx_bad_auth_extra. Positions start at 1. Remove extras and analyze again.",
  hash: "Inner transaction hash", note: "This checks envelope authorization using current Horizon signer snapshots. It does not validate sequence numbers, fees, time bounds, balances, operation effects or Soroban contract authorization. Account settings can change before submission. Nothing is signed or submitted.",
} as const;
export const errorCopy: Record<MultisigAnalyzerErrorCode, { title: string; description: string }> = {

  empty_input: { title: "Enter the required values", description: "Fill in the public account fields and try again." },
  invalid_address: { title: "Check the public address", description: "Use a valid Stellar public account address beginning with G." },
  secret_key: { title: "Use public information only", description: "Secret keys are not accepted. Paste a public address or transaction envelope." },
  account_not_found: { title: "Account not found", description: "Check the address and selected network. The account must exist on that network." },
  rate_limited: { title: "Too many requests", description: "Wait a moment before trying again." },
  timeout: { title: "Horizon took too long", description: "Try again when the network responds." },
  network_unavailable: { title: "Connection unavailable", description: "Check your connection and try again." },
  invalid_response: { title: "Incomplete Horizon response", description: "The response could not be verified. Try again with a healthy Horizon endpoint." },
  request_failed: { title: "The request did not complete", description: "Try again. Check the selected network if the problem continues." },


  invalid_xdr: { title: "Cannot decode this envelope", description: "Paste a complete base64 Stellar transaction envelope." },
  input_too_large: { title: "Envelope is too large", description: "Use an envelope of at most 200000 base64 characters." },
  source_mismatch: { title: "The source address does not match", description: "Use the base G address of the inner transaction source." },
  unsupported_operation: { title: "Unknown operation threshold", description: "This envelope contains an operation this analyzer does not yet support." },
};
