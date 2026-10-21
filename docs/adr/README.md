# Architecture decision records

An ADR records one architectural decision: the situation that forced it, what
was decided, and what that costs. The contract in
[FEATURE_CONTRACT.md](../FEATURE_CONTRACT.md) says *what* a slice must do;
these records say *why*, so a later change can revisit a decision knowingly
instead of undoing a deliberate trade-off by accident.

## When an ADR is required

Any pull request that changes [FEATURE_CONTRACT.md](../FEATURE_CONTRACT.md) —
a rule, the required layout, or what `npm run verify:features` enforces — adds
a new ADR or supersedes an existing one in the same pull request. Changes that
only clarify wording do not need one.

## How to write one

1. Copy [template.md](./template.md) to `NNNN-short-title.md`, using the next
   free number. Numbers are never reused.
2. Fill in Context, Decision and Consequences. Link the commits, issues or
   pull requests the decision rests on; do not state rationale that cannot be
   traced to one of them.
3. Add a row to the index below.

Accepted ADRs are not rewritten. To change a decision, write a new ADR, set the
old one's status to `Superseded by NNNN`, and update both rows.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](./0001-vertical-feature-slices.md) | One self-contained directory per tool | Accepted |
| [0002](./0002-generated-gitignored-registry.md) | The tool registry is generated and gitignored | Accepted |
| [0003](./0003-result-values-and-error-codes.md) | Expected failures are `Result` values with coded errors | Accepted |
| [0004](./0004-slice-local-fixtures-and-network-boundary-mocks.md) | Fixtures live in the slice; requests are mocked with MSW | Accepted |
| [0005](./0005-runtime-contract-migration-ledger.md) | Runtime contract states are enforced with a shrinking ledger | Accepted |
| [0006](./0006-shared-amount-and-date-formatting.md) | Amounts and dates go through `core/format` | Accepted |
| [0007](./0007-documented-read-only-threat-boundaries.md) | Each slice documents its read-only threat boundary; signing code is scanned for | Proposed |
