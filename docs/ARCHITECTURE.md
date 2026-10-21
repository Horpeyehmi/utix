# Architecture

RevyHubX is a Next.js App Router application built from two parts: a small
stable **core** and any number of independent **feature slices**.

```
core/        shared kernel — changes rarely, reviewed carefully
features/    one directory per tool — added freely, never collides
app/         layout, dashboard, one dynamic tool route, and GET /api/status
scripts/     registry generation, scaffolding, contract verification
```

## core/

| Module | Responsibility |
| --- | --- |
| `core/result` | `Result<T, Code>` — the shared success/failure shape |
| `core/telemetry` | Structured, redacted logs for every critical path |
| `core/workers` | Background worker framework: delayed, retryable, dead-lettered jobs |
| `core/lifecycle` | Record state machines: declared states, legal transitions, rejected moves |
| `core/idempotency` | Idempotency keys, persisted outcomes and replay protection |
| `core/reconciliation` | Dry-run reconciliation of stored records against derived state, with root-cause hints and a confirmed, re-checked repair workflow |
| `core/operations` | Recovery for interrupted multi-step flows: checkpoints, resume, stuck-operation diagnostics |
| `core/audit` | Append-only audit trail for sensitive user and maintainer actions |
| `core/export` | Privacy-safe, scoped, schema-versioned data exports |
| `core/contract` | API contract schemas and drift detection |
| `core/status` | Public status feed and the operator service mode (degraded, paused, maintenance) behind `/api/status` and the site banner |
| `core/network` | Network selection, URLs, passphrases, `NetworkProvider` |
| `core/horizon` | Memoised Horizon client and the shared error taxonomy |
| `core/rpc` | Minimal Soroban JSON-RPC caller |
| `core/format` | Stellar amount parsing/formatting and date formatting, locale-aware and exact |
| `core/registry` | Feature manifest types and the generated registry |
| `core/ui` | Accessible primitives: `Field`, `StatusMessage`, `DataList`, … |
| `core/layout` | App shell, header, sidebar |
| `core/testing` | `renderFeature`, MSW harness, axe assertions |
| `core/lib` | `cn`, clipboard, string helpers |

Core is where cross-cutting behaviour lives. A change here affects every tool,
so it is deliberately small and separate from the work contributors do.

## features/

Each directory under `features/` is a self-contained tool. The full
specification is in [FEATURE_CONTRACT.md](./FEATURE_CONTRACT.md).

## The generated registry

`scripts/generate-registry.mjs` scans `features/*/manifest.ts` and writes the
manifest list plus lazy loaders into `core/registry/`:

| File                     | Used by                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `manifests.generated.ts` | Navigation, dashboard, search, `generateStaticParams`                 |
| `registry.generated.ts`  | Direct entry lookup with `load: () => import("@/features/.../panel")` |
| `panels.generated.ts`    | Optional lazy map kept for analysis/debugging only                    |

All three are **gitignored** and regenerated automatically on `predev`,
`prebuild`, `pretest`, `prelint` and `postinstall`.

This is the central design decision. Because the registry is generated rather
than committed:

- adding a tool requires no edit to any shared file,
- dozens of feature branches can be open without conflicting,
- and navigation, routing and search stay in sync automatically.

The registry keeps a metadata-only manifest and a lazy implementation loader. A
feature's metadata is eagerly imported so nav/search can render instantly, while
its panel implementation is only fetched when the tool route is visited. The
shared bundle budget is therefore: zero eager feature-panel imports and zero
module-side costs from individual slice implementations in the landing page.

## Routing

One route serves every tool:

```
app/tools/[slug]/page.tsx
```

It resolves the slug against the registry, renders `FeatureShell` (heading,
character line, network badges) and mounts the slice's panel.
`generateStaticParams` prerenders every registered tool at build time.

## Data flow inside a slice

```
form input
   ↓  schema.ts          raw string → Result<Input, Code>
   ↓  hooks/use<Name>    state machine, network tagging, request identity
   ↓  lib/<domain>.ts    Horizon / RPC / local computation → Result<T, Code>
   ↓  lib/format.ts      values → display strings
   ↓  components/        idle | loading | success | error
```

Validation happens before any request. Transport failures are mapped to the
slice's own error codes by `lib/<domain>.errors.ts`, so a component never sees
a raw exception.

## Testing

`vitest` with jsdom, Testing Library, MSW and axe-core.

- `core/testing/render.tsx` — `renderFeature` wraps components in the real
  providers and returns a bound `userEvent`.
- `core/testing/msw.ts` — `withMswHandlers` installs a server with the standard
  lifecycle hooks. Unhandled requests fail the test.
- `core/testing/axe.ts` — `expectNoAxeViolations` fails with a readable report.

Requests are always mocked at the network boundary. `vi.mock` on an internal
module would test the mock instead of the code.

## Quality gates

```bash
npm run check    # registry → lint → test → verify:* → fixtures → build
```

CI runs the same steps on every pull request, including
`npm run verify:features`, which fails a slice that does not meet the contract,
`npm run verify:issues`, which preserves a backlog of at least 40
independent specifications with a stable 20-issue advanced wave,
`npm run verify:reconciliation`, which fails if a declared invariant is never
checked or has no repair strategy, if the dry run ever grows a write path, or
if the repair path loses one of its dry-run-first guards,
`npm run verify:audit`, which fails if a declared sensitive action has no
emitter at a domain boundary, if a boundary records an undeclared one, or if the
trail ever gains an update, a delete or an unredacted context, and
`npm run verify:fixtures`, which imports every `features/*/fixtures/*.fixture.ts`
file and fails with the specific file if a `@stellar/stellar-sdk` upgrade
broke it.

### SDK upgrades

Fixtures are decentralized — one `fixtures/` directory per slice, owned by
that slice's contributor — so there is no single place to eyeball after
bumping `@stellar/stellar-sdk`. Most fixtures build their values with real SDK
calls (`Keypair`, `TransactionBuilder`, `xdr.*`) rather than hand-typing them,
so a renamed export or changed constructor throws the moment the fixture
module loads. Run `npm run verify:fixtures` as part of every SDK-upgrade PR —
it reports exactly which fixture file failed to import and why.

See [ISSUE_PUBLISHING.md](./ISSUE_PUBLISHING.md) for the five-at-a-time
GrantFox publication flow.

## Decision records

Why the architecture is shaped this way — slices, the generated registry,
`Result` error codes, slice-local fixtures, the runtime contract ledger and
shared formatting — is recorded in [adr/](./adr/README.md). Read the relevant
record before proposing to change one of those decisions.
