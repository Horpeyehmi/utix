/**
 * All user-facing strings for the duplicate-transaction-scanner slice.
 *
 * No text lives in components — they import this object and assert against it
 * in tests.
 */
export const copy = {
  // Panel heading & description
  title: "Duplicate Transaction Scanner",
  description:
    "Paste up to 20 transaction hashes (one per line). The scanner computes a deterministic fingerprint for each and groups any that appear structurally identical. Review each candidate group and confirm, dismiss, or defer.",

  // Form
  hashesLabel: "Transaction Hashes",
  hashesHint: "One 64-character hex hash per line. Maximum 20.",
  hashesPh: "e.g. 6bc1bee22e40...",
  submitLabel: "Scan for Duplicates",

  // Empty state
  emptyHeading: "No scan yet",
  emptyBody:
    'Enter one or more Stellar transaction hashes above and click "Scan for Duplicates".',

  // Loading
  loadingLabel: "Scanning transactions…",

  // Success summary
  resultSummaryNone: (n: number) =>
    `Scanned ${n} transaction${n === 1 ? "" : "s"} — no duplicate groups found.`,
  resultSummaryFound: (scanned: number, groups: number) =>
    `Scanned ${scanned} transaction${scanned === 1 ? "" : "s"} — ${groups} duplicate group${groups === 1 ? "" : "s"} found.`,

  // Group card
  groupFingerprintLabel: "Fingerprint",
  groupStateLabel: "State",
  groupSourceLabel: "Source account",
  groupOpsLabel: "Operation types",
  groupFeeLabel: "Fee charged",
  groupMemoLabel: "Memo",
  groupWindowLabel: "5-min time window",
  groupTransactionsLabel: "Matching transactions",
  transactionHashLabel: "Hash",
  transactionLedgerLabel: "Ledger",
  transactionCreatedAtLabel: "Created at",
  transactionSuccessful: "Successful",
  transactionFailed: "Failed",

  // Review actions
  confirmLabel: "Confirm Duplicate",
  confirmAria: "Confirm this group as real duplicates",
  dismissLabel: "Dismiss",
  dismissAria: "Dismiss this group — mark transactions as distinct",
  deferLabel: "Defer",
  deferAria: "Defer review of this group to the next scan",

  // State labels
  states: {
    pending: "Pending review",
    confirmed: "Confirmed duplicate",
    dismissed: "Dismissed",
    deferred: "Deferred",
  } satisfies Record<string, string>,

  // Error messages
  errors: {
    empty_input: "Enter at least one transaction hash.",
    too_many_hashes: "Maximum 20 hashes per scan. Remove some and try again.",
    invalid_hash:
      "Every hash must be a 64-character hexadecimal string. Check for typos or extra whitespace.",
    not_found:
      "One or more hashes were not found on the selected network. Check the hash and network.",
    rate_limited: "Horizon rate-limited this request. Wait a moment and try again.",
    request_failed: "Horizon request failed. Check your network connection and try again.",
    invalid_transition:
      "This group cannot be reviewed — it has already been confirmed or dismissed.",
  } satisfies Record<string, string>,

  // Accessibility
  scanResultRegionLabel: "Scan results",
  groupListLabel: "Candidate duplicate groups",
} as const;
