
# Utix

An open-source toolkit of small, focused utilities for Stellar developers —
address validation, balance and trustline inspection, transaction lookup,
payment requests, wallet detection and testnet funding, with more tools being
added continuously by contributors.

Every tool is read-only. Utix never asks for a secret key and never signs
or submits a transaction.

## Architecture in one paragraph

The app is a small stable **core** plus any number of independent **feature
slices**. Each tool is one directory under `features/` that owns its logic,
validation, state, UI, tests, fixtures, request mocks and documentation. The
tool registry is _generated_ from those directories, so adding a tool requires
creating one new directory and editing nothing else — which is what lets many
contributors work in parallel without ever conflicting.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and
[docs/FEATURE_CONTRACT.md](./docs/FEATURE_CONTRACT.md).

Infrastructure docs: [Telemetry](./docs/TELEMETRY.md) ·
[Workers](./docs/WORKERS.md) · [Exports](./docs/EXPORTS.md) ·
[Record lifecycles](./docs/LIFECYCLE.md) ·
[Idempotency](./docs/IDEMPOTENCY.md) ·
[Operation recovery](./docs/OPERATION_RECOVERY.md) ·
[Reconciliation](./docs/RECONCILIATION.md) ·
[Audit trail](./docs/AUDIT.md) ·
[Tamper-evident ledger](./docs/LEDGER.md) ·
[Fee calculation](./docs/FEES.md) ·
[Anomaly detection](./docs/ANOMALY_DETECTION.md) ·
[Authorization expiry](./docs/AUTHORIZATIONS.md) ·
[Public status feed](./docs/PUBLIC_STATUS.md) ·
[Seed data](./docs/SEED_DATA.md) ·
[API Contract](./docs/API_CONTRACT.md) ·
[Event contract map](./docs/EVENT_CONTRACT_MAP.md) ·
[Rollout guard & rollback](./docs/ROLLOUT_GUARD_AND_ROLLBACK.md) ·
[Abuse detection](./docs/ABUSE_DETECTION.md) ·
[Storage schema migration](./docs/STORAGE_SCHEMA_MIGRATION.md).

## Tools

| Tool                 | What it does                                                         |
| -------------------- | -------------------------------------------------------------------- |
| Address Validator    | Validates Stellar addresses and explains exactly why one is rejected |
| Balance Viewer       | Every balance an account holds, including pool shares                |
| Trustline Checker    | Whether an account trusts a specific asset from a specific issuer    |
| Payment QR Generator | Builds a SEP-0007 request and renders it as a QR code                |
| Transaction Lookup   | Ledger, fee, memo, result and operations for a transaction hash      |
| Freighter Connect    | Detects the wallet and warns about a network mismatch                |
| Testnet Faucet       | Funds a testnet account through Friendbot                            |
| Anomaly Report       | Read-only report of unusual volume, timing and actor behavior        |
|                      | Grouped by severity and affected resource, with triage guidance      |
|                      | Signals: volume spikes, timing anomalies, actor repetition, failures |

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS ·
`@stellar/stellar-sdk` · Vitest · Testing Library · MSW · axe-core

## Local setup

```bash
git clone https://github.com/BigDella/utix.git
cd utix
npm install
npm run dev
```

Optional environment overrides:

```env
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_HORIZON_TESTNET_URL=https://horizon-testnet.stellar.org
NEXT_PUBLIC_HORIZON_MAINNET_URL=https://horizon.stellar.org
NEXT_PUBLIC_SOROBAN_RPC_TESTNET_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_SOROBAN_RPC_MAINNET_URL=https://mainnet.sorobanrpc.com
```

Testnet is the default, and the network switch in the header is persisted.

## Commands

```bash
npm run dev                  # dev server
npm run registry             # regenerate the feature registry
npm run new:feature          # scaffold a complete feature slice
npm run verify:features      # check every slice against the feature contract
npm run verify:issues        # check 40+ independent issues and the advanced wave
npm run verify:telemetry     # verify >= 5 operations are instrumented
npm run verify:reconciliation # every invariant is checked, the dry run is read-only, repair is dry-run-first
npm run verify:contract      # run the API contract drift tests
npm run verify:anomaly       # anomaly report identifies fixture spikes, repeats and suspicious actors
npm run verify:anomaly       # validates severity grouping, resource grouping and triage output
npm run verify:replay        # versioned event replay suite
npm run verify:replay-concurrency # deterministic concurrent-write and retry replay tests
npm run test:workers         # run the background worker suite
npm test -- core/lifecycle   # allowed and rejected record state transitions
npm test -- core/idempotency # retry, replay, expiry and key collisions
npm test -- core/reconciliation # drift, root-cause hints, repair plan/apply/rollback
npm test -- features/anomaly-report # baseline, spike, repeated failure and suspicious actor scenarios
npm test -- features/anomaly-report # also covers false-positive mitigation and severity grouping
npm run issues               # preview the next five GrantFox issue payloads
npm run test                 # unit, hook, component and accessibility tests
npm run test:e2e              # full Playwright suite
npm run test:e2e:critical     # deterministic account-history journey
npm run test:coverage        # unit tests with a coverage summary
npm run lint
npm run build
npm run check                # everything CI runs
npm run bundle:check         # check per-feature bundle size budgets
npm run recovery:validate    # validate data integrity after restore
npm run health:check         # operational health dashboard
```

The critical journey is the public account-history flow: enter an address,
load operation history, follow its cursor, and recover from a transient
request failure. Its Playwright tests use fixed SDK-derived fixtures and route
all Horizon calls locally; `npm run test:e2e:critical` is the reproducible
local command.

For the account-history accessibility pass, manually verify keyboard-only
entry and submission, visible focus after an invalid address, announced
validation and request errors, filter and pager updates, notification
open/close/read states, and 200% zoom without clipped controls. Run the
component axe suite with `npm test` and record a browser and screen-reader
version in the issue before submitting.

## Contributing

Most open issues ask for a new tool, and each one is a complete vertical slice.
Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and
[docs/FEATURE_CONTRACT.md](./docs/FEATURE_CONTRACT.md), then:

```bash
npm run new:feature -- <slug> "<Title>" <category>
```

Maintainers publish contributor work in independent batches of five using the
[GrantFox issue workflow](./docs/ISSUE_PUBLISHING.md).

`npm run test:coverage` writes the human-readable table to
`coverage/coverage.txt` and machine-readable totals to
`coverage/coverage-summary.json`. Coverage is informational and does not
enforce a global percentage threshold.

## Operations and Maintenance

See documentation for operational workflows:

- [RBAC.md](./docs/RBAC.md) - Role-based access control system
- [DISASTER_RECOVERY.md](./docs/DISASTER_RECOVERY.md) - Data validation after restore
- [OPERATIONAL_HEALTH.md](./docs/OPERATIONAL_HEALTH.md) - Health monitoring dashboard
- [BUNDLE_BUDGET.md](./docs/BUNDLE_BUDGET.md) - Per-feature bundle size enforcement
- [ANOMALY_DETECTION.md](./docs/ANOMALY_DETECTION.md) - Anomaly signals, severity triage and false-positive mitigation

## Security

See [SECURITY.md](./SECURITY.md). Utix is read-only by design.

The anomaly report is read-only and groups findings by severity and affected
resource. See [docs/ANOMALY_DETECTION.md](./docs/ANOMALY_DETECTION.md) for the
signal definitions and maintainer triage guidance.

False-positive mitigation is documented in the same guide: baseline windows,
minimum sample sizes, and per-signal suppression rules keep normal traffic
from being flagged while still surfacing genuine spikes, repeats and failures.
