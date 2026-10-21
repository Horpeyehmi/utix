# 0007. Document each slice's read-only threat boundary and scan for signing code

- Status: Proposed
- Date: 2026-10-21
- Sources: issue #157 ("Document read-only threat boundaries per feature"); [SECURITY.md](../../SECURITY.md); [FEATURE_CONTRACT.md](../FEATURE_CONTRACT.md) rules 10 and 15; [0005](./0005-runtime-contract-migration-ledger.md)

## Context

The project never signs or submits a transaction, but that promise was recorded
only in SECURITY.md and in each README's free-form "Safety" paragraph. A
reviewer checking a new slice had to reconstruct, from the code, what data it
reads, which hosts it calls and why it cannot sign. Nothing failed when a slice
left that out, and nothing failed when runtime code called a signing API.
Seventy slices already existed when the rule was introduced, so requiring the
documentation everywhere at once would have blocked unrelated work.

## Decision

Every slice README carries a `## Threat boundary` section with three labelled
answers: **Data sources**, **Outbound requests** and **Cannot sign or submit**.
`verify:features` fails a slice whose section is missing, empty or still `TODO`.
Slices that predate the rule are listed in
`scripts/threat-boundary-migration.json` and warn instead, following the
shrinking-ledger approach of [0005](./0005-runtime-contract-migration-ledger.md).
`trustline-checker` is documented as the reference example.

`verify:features` also scans each slice's runtime sources for signing and
submission calls and fails on any match. That scan has no ledger, because no
existing slice makes such a call.

## Consequences

- New slices must fill in the section in their first pull request; the
  scaffold's `TODO` placeholders fail until they do.
- Documenting one existing slice and removing it from the ledger is a
  self-contained change. The ledger must never grow.
- The signing scan is a pattern match. It catches the obvious APIs but cannot
  prove a negative, so review against the documented boundary is still
  required. A legitimate future need for one of the matched names in runtime
  code means changing this decision, not working around the scan.
- Fixtures, tests, e2e specs and request mocks are outside the scan, so
  deterministic signed sample envelopes stay possible.
