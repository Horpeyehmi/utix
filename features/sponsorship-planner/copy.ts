import type { SponsorshipPlannerErrorCode } from "./types";
export const copy = {
  sponsor: "Sponsor public address", account: "Sponsored public address",
  addressHint: "Use a public G address. Never paste a secret key.",
  planned: "New entries to create", countsHint: "Plan additional entries, not entries already on the account. Pool-share trustlines require two reserve units each.",
  kinds: { trustlines: "Trustlines", poolTrustlines: "Pool-share trustlines", offers: "Offers", signers: "Additional signers", dataEntries: "Data entries" },
  sponsorKind: (label: string) => `Sponsor ${label.toLowerCase()}`,
  sponsorAccount: "Sponsor the new account's base reserve", accountHint: "Applies only when the sponsored address does not exist yet. Existing account sponsorships remain in the baseline.",
  submit: "Plan reserves", loading: "Loading accounts and base reserve…",
  emptyTitle: "Plan who pays each reserve", emptyDescription: "Enter both public addresses and the new entries to create. The plan includes existing reserve commitments and XLM selling liabilities.",
  resultTitle: "Reserve plan", newAccount: "This plan creates a new sponsored account.", existingAccount: "This plan adds entries to an existing account.",
  base: "Base reserve", units: "Reserve units paid by sponsor", cost: "Additional sponsor reserve", sponsorMinimum: "Sponsor minimum balance after setup",
  available: "Sponsor available XLM after setup", sponsorShortfall: "Sponsor funding still needed", accountMinimum: "Sponsored account minimum after setup", accountShortfall: "Sponsored account funding still needed",
  tableCaption: "Planned new entries and their reserve payer", kind: "Entry", count: "Count", reserveUnits: "Reserve units", payer: "Reserve payer", sponsorPays: "Sponsor", accountPays: "Sponsored account",
  note: "Estimates use the latest reported base reserve. Amounts exclude transaction fees, asset funding and new trading liabilities. Existing commitments and XLM selling liabilities are included. No transaction is built, signed or submitted.", xlm: "XLM",
} as const;
export const errorCopy: Record<SponsorshipPlannerErrorCode, { title: string; description: string }> = {

  empty_input: { title: "Enter the required values", description: "Fill in the public account fields and try again." },
  invalid_address: { title: "Check the public address", description: "Use a valid Stellar public account address beginning with G." },
  secret_key: { title: "Use public information only", description: "Secret keys are not accepted. Paste a public address or transaction envelope." },
  account_not_found: { title: "Account not found", description: "Check the address and selected network. The account must exist on that network." },
  rate_limited: { title: "Too many requests", description: "Wait a moment before trying again." },
  timeout: { title: "Horizon took too long", description: "Try again when the network responds." },
  network_unavailable: { title: "Connection unavailable", description: "Check your connection and try again." },
  invalid_response: { title: "Incomplete Horizon response", description: "The response could not be verified. Try again with a healthy Horizon endpoint." },
  request_failed: { title: "The request did not complete", description: "Try again. Check the selected network if the problem continues." },


  same_account: { title: "Choose two different accounts", description: "An account cannot sponsor itself." },
  invalid_count: { title: "Check the entry counts", description: "Use whole counts between 0 and 10000 for each entry type." },
  existing_account_base: { title: "This account already exists", description: "Clear the new-account base reserve option. This planner adds new subentries and preserves existing sponsorships." },
};
