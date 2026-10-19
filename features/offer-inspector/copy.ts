import type { OfferInspectorErrorCode } from "./types";
export const copy = {
  formLabel: "Public account address", formHint: "Read-only lookup on the selected network. Never paste a secret key.",
  submit: "Inspect offers", loading: "Loading open offers…",
  emptyTitle: "Inspect the offers holding your balance", emptyDescription: "Enter an account to see selling amounts, exact buying prices and the reserve payer for each open offer.",
  resultTitle: "Open offers", noOffers: "No open offers on this page.",
  caption: "Open offers for the selected account", id: "Offer", selling: "Selling asset", buying: "Buying asset",
  amount: "Selling amount", price: "Buying units per selling unit", reserve: "Reserve (XLM)", payer: "Reserve payer",
  accountPays: "This account", sponsoredBy: "Sponsored by", next: "Next page", first: "Submit the account again to return to the first page.",
  note: "Up to 50 offers per page. Reserve totals apply to this page. Selling amounts remain tied up in offers in addition to reserve requirements. Offers can change between requests.",
  ownReserve: "Account-funded reserve on this page", sponsoredReserve: "Sponsored reserve on this page", xlm: "XLM",
} as const;
export const errorCopy: Record<OfferInspectorErrorCode, { title: string; description: string }> = {

  empty_input: { title: "Enter the required values", description: "Fill in the public account fields and try again." },
  invalid_address: { title: "Check the public address", description: "Use a valid Stellar public account address beginning with G." },
  secret_key: { title: "Use public information only", description: "Secret keys are not accepted. Paste a public address or transaction envelope." },
  account_not_found: { title: "Account not found", description: "Check the address and selected network. The account must exist on that network." },
  rate_limited: { title: "Too many requests", description: "Wait a moment before trying again." },
  timeout: { title: "Horizon took too long", description: "Try again when the network responds." },
  network_unavailable: { title: "Connection unavailable", description: "Check your connection and try again." },
  invalid_response: { title: "Incomplete Horizon response", description: "The response could not be verified. Try again with a healthy Horizon endpoint." },
  request_failed: { title: "The request did not complete", description: "Try again. Check the selected network if the problem continues." },

  invalid_cursor: { title: "Invalid page cursor", description: "Submit the account again to restart the lookup." },
};
