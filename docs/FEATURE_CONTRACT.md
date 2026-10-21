# The RevyHubX feature contract

Every tool in RevyHubX is a **vertical slice**: one directory under `features/`
that owns its logic, validation, state, UI, tests, fixtures, request mocks and
documentation. Nothing about a tool lives outside its own directory.

This document is the specification each tool issue is written against.
`npm run verify:features` enforces it, and CI runs that check on every pull
request.

---

## Why slices instead of layers

The usual layout — `components/`, `lib/`, `hooks/`, `tests/` — forces every
contributor to edit the same shared files. With dozens of open pull requests
that produces constant conflicts in `constants.ts`, barrel files and route
tables, and none of the work is really independent.

Here, adding a tool means **creating one new directory and editing nothing
else**:

- Routing is a single dynamic route, `app/tools/[slug]/page.tsx`. You do not
  create a route file.
- The registry is **generated** from the directories under `features/` by
  `scripts/generate-registry.mjs`, and the generated files are gitignored. You
  do not edit a registry, a navigation list, or a constants file.
- Navigation, the dashboard and search all read that generated registry, so a
  new tool appears in all three the moment its directory exists.
- The registry is split into metadata and lazy loaders: `manifest` is eager, but
  each entry exposes `load: () => import("@/features/<slug>/panel")`. That
  keeps the shared nav/search bundle metadata-only and avoids pulling every
  feature panel into the initial JavaScript.

The structural validator in `scripts/generate-registry.mjs` enforces the
registry budget automatically: every feature must keep its metadata in
`manifest.ts`, its panel in `panel.tsx`, and it may not import another feature's
internal modules. A directory is rejected with a file-and-slice-specific error if
its slug duplicates another tool, its manifest omits required fields, or it
crosses feature boundaries.

Two contributors working on two different tools cannot conflict, because they
never touch the same file.

---

## Required layout

```
features/<slug>/
├── manifest.ts                     registry metadata
├── panel.tsx                       default export used by the route
├── types.ts                        the slice's own types and error codes
├── schema.ts                       raw input → validated request
├── copy.ts                         every user-facing string
├── lib/
│   ├── <domain>.ts                 the tool's logic
│   ├── <domain>.errors.ts          transport failures → this tool's codes
│   └── format.ts                   presentation helpers
├── hooks/
│   └── use<Name>.ts                the state machine
├── components/
│   ├── <Name>Panel.tsx             composes the states
│   ├── <Name>Form.tsx              input
│   ├── <Name>Result.tsx            success
│   └── <Name>EmptyState.tsx        the pre-interaction state
├── __tests__/
│   ├── <domain>.test.ts            logic
│   ├── schema.test.ts              validation
│   ├── format.test.ts              formatting
│   ├── use<Name>.test.tsx          hook
│   ├── <Name>Panel.test.tsx        component
│   └── a11y.test.tsx               axe, WCAG 2.1 A/AA
├── fixtures/
│   └── <domain>.fixture.ts         deterministic sample data
├── msw/
│   └── handlers.ts                 request mocks (required if it makes requests)
├── e2e/
│   └── <slug>.spec.ts              end-to-end specification
└── README.md                       what it does, how, why, and its threat boundary
```

**Minimum 20 files.** A complete slice lands at 23-25 without padding.

Scaffold the whole structure with:

```bash
npm run new:feature -- <slug> "<Title>" <category>
```

---

## The rules behind the layout

### 1. Logic never throws for expected failures

Anything the user can cause is a value, not an exception. Use
`Result<T, Code>` from `@/core/result/result`:

```ts
if (!StrKey.isValidEd25519PublicKey(accountId)) return err("invalid_address");
return ok({ accountId });
```

Error **codes** are the interface — never English strings. The UI maps codes to
copy. That is what makes messages translatable, testable and refactorable.

### 2. Error codes are specific enough to act on

`request_failed` is a last resort. A user who typed one wrong character and a
user whose account does not exist on the selected network need different
advice, so they get different codes. Every code must map to copy that says what
to do next.

### 3. All strings live in `copy.ts`

No user-facing text inside components. Tests import `copy` and assert against
it, so wording changes never break the test suite.

### 4. Amounts and dates go through `@/core/format`

Stellar amounts have 7 decimal places and can exceed `Number.MAX_SAFE_INTEGER`,
so they are never parsed as floats. Every slice that accepts or displays an
amount uses `@/core/format/amount`:

- **Input** — `parseAmount` accepts one fixed, locale-independent grammar:
  ASCII digits, an optional leading `-`, and `.` as the only decimal
  separator, with at most seven decimals. A comma, space, apostrophe or
  underscore is rejected with `grouping_separator` instead of being guessed at:
  `1,234` is 1234 in en-US and 1.234 in de-DE. Map that code to copy telling
  the user to write `1234.5`.
- **Display** — `formatAmount` shows the value in the user's locale (grouping,
  decimal separator, digit shapes) through `Intl.NumberFormat`, but only the
  whole part goes through `Intl`, as a `BigInt`; the fraction digits are
  appended unchanged, so no locale ever rounds a stroop away.

Dates use `formatDateTime` / `formatUnixSeconds` from `@/core/format/date`:
the user's locale decides the shape, and the time zone is always UTC and
printed, so ledger times can be compared against explorers.

### 5. Four UI states, always

Idle (empty state), loading, success, error. The panel composes them; no state
is skipped because it "rarely happens".

### 6. Network results are tagged and derived

If a tool reads the chain, its result belongs to the network it came from.
Store the network beside the state and derive staleness during render — do not
reset in an effect. `useBalanceViewer` is the reference.

### 7. Accessibility is a test, not an intention

`a11y.test.tsx` runs axe over the real rendered markup and must report zero
WCAG 2.1 A/AA violations, in **at least two states** — usually initial and
"result shown". Use `Field` from `@/core/ui` so labels, hints, `aria-invalid`
and `aria-describedby` are wired correctly for free.

Announce errors once. A field-level error already carries `role="alert"`, so do
not also render a banner for it — see `TrustlineCheckerPanel`.

### 8. Fixtures are derived, never hand-typed

Hand-written Stellar addresses have wrong checksums. Derive them:

```ts
const seed = (byte: number) =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, byte));
export const accountId = seed(1).publicKey();
```

### 9. Requests are mocked with MSW, never with `vi.mock`

Mock at the network boundary so the test exercises the real client. Call
`resetHorizonClients()` before a request when a test changes handlers — the
Horizon client is memoised per network.

### 10. Never accept, display, store or transmit a secret key

Reject anything starting with `S` on the prefix alone, before any checksum
check, and never render it back. `features/address-validator` has two tests
asserting the seed appears in neither component output nor hook state. Every
slice that takes an address needs the equivalent.

### 11. Tests exercise the runtime contract, not just the file layout

Having a `__tests__/` directory proves nothing about behaviour. Every slice's
tests must drive it through its **loading**, **error** and **empty** states
using the shared harness in `@/core/testing/contract`:

```tsx
import { renderFeatureSlice } from "@/core/testing/contract";

const slice = renderFeatureSlice("balance-viewer", <BalanceViewerPanel />);

slice.expectEmptyState(); // idle, before any input
await user.click(screen.getByRole("button", { name: copy.submit }));
await slice.waitForState("loading"); // request in flight
await slice.waitForState("error"); // request failed
```

The harness asserts against the `data-contract-state` attribute that the shared
state primitives render — `EmptyState` (`"empty"`), `StatusMessage` (`"error"`,
`"success"`, …) and `Skeleton`/`SkeletonRows` (`"loading"`) — instead of against
copy. That is what lets the same three helpers work for a lookup form, a QR
generator and a wallet-connect flow. A slice with a bespoke indicator (a
spinner, a skeleton it renders itself) can carry
`data-contract-state="loading"` on it and get the same treatment.

`npm run verify:features` reads each slice's `__tests__/` sources: if they never
call `expectLoadingState()`, `expectErrorState()` and `expectEmptyState()` (or
the generic `expectState("…")` / `waitForState("…")` forms), the slice fails
with a message naming the state it skips. Slices that predate this rule are
listed in `scripts/feature-contract-migration.json` and are reported as a
warning instead of a failure. **That list is a migration ledger: it must only
shrink, and new slices are never added to it.**

The checker itself is covered by `core/__tests__/verifyFeaturesContract.test.ts`
against the deliberately minimal `good` and `bad` fixture slices under
`scripts/__tests__/fixtures/`, so a regression that makes the rule always pass
(or always fail) fails the normal test run.

---

### 12. Feature imports stop at slice boundaries

A feature may import its own files, `core/`, and external packages. It must not
import another feature, including through a deep relative path. Move genuinely
shared code into `core/`. `npm run verify:boundaries` enforces this in CI and
has both alias and relative-path failure fixtures. An exception requires a
documented architectural reason and maintainer approval in
`scripts/feature-boundary-exceptions.json`; inline suppressions are
intentionally unsupported. The checked-in entries are legacy migration debt,
not examples to copy.

### 13. Network switches are atomic

`NetworkContext` exposes a monotonically increasing `epoch`. The provider keys
its feature boundary by `{network}:{epoch}`, so switching networks immediately
unmounts every result and in-flight state. Async callbacks from the previous
epoch therefore cannot overwrite the new network's UI. Network-aware hooks
must use `useNetwork`; do not create a separate network preference or cache.
Tools that deliberately query multiple networks independently must declare
`networkEpochIndependent: true` in their manifest so the verifier can
distinguish that design from an accidental context bypass.

### 14. Generated registry output is versioned

Every generated registry module exports `generatedRegistrySchemaVersion`.
Navigation, search, panel lookup, and `verify:features` assert that it matches
`FEATURE_REGISTRY_SCHEMA_VERSION`. To change the format: update the generator,
consumers, schema constant, and old-schema regression test in one pull request;
then run `npm run registry`. Treat each increment as a small registry-format
changelog in the pull request description.

### 15. Every slice documents its read-only threat boundary

Read-only is the project's central promise, and it has to be checkable in every
independently contributed slice rather than taken on trust. Each slice's
`README.md` ends with a `## Threat boundary` section that answers three
questions, each as a bold label followed by the answer on the same line:

```md
## Threat boundary

- **Data sources:** every input the tool reads — form fields, pasted XDR or
  URIs, files, Horizon or RPC responses, browser storage.
- **Outbound requests:** the method, host and path of each request, or
  "None — runs entirely in the browser", and what user data the URL carries.
- **Cannot sign or submit:** the proof — which input rejects a secret key and
  the test that shows it, and that the slice calls no signing or submission
  API.
```

[`features/trustline-checker/README.md`](../features/trustline-checker/README.md)
is the reference example.

#### Reviewer checklist

When reviewing a slice, check the section against the code, not just its
presence:

- [ ] **Data sources** matches what `schema.ts` and `lib/` actually read.
- [ ] **Outbound requests** lists every `fetch`, `horizonServer(...)` and RPC
      call in `lib/`, each against a public, read-only endpoint, and
      `msw/handlers.ts` mocks exactly those requests.
- [ ] No request URL or body carries anything a user would consider private.
- [ ] **Cannot sign or submit** names the validation that rejects `S…` secret
      keys (or explains why the tool takes no address at all) and the test that
      proves it.
- [ ] The slice adds no wallet integration that requests a signature.

#### What `verify:features` enforces

- **Documentation presence.** A README without the section, or with an empty or
  `TODO` answer for any field, fails. `npm run new:feature` scaffolds the
  section with `TODO` placeholders, so a new slice fails until it is filled in.
  Slices that predate this rule are listed in
  `scripts/threat-boundary-migration.json` and produce a warning instead. Like
  the rule 11 ledger, **it must only shrink, and new slices are never added to
  it.**
- **No signing code.** Runtime sources (everything except `__tests__/`,
  `fixtures/`, `e2e/` and `msw/`) must not call `Keypair.fromSecret`,
  `Keypair.random`, `Keypair.fromRawEd25519Seed`, `.sign(…)`,
  `signTransaction`/`signAuthEntry`/`signMessage`/`signBlob`,
  `submitTransaction`, or the RPC `sendTransaction` method. This rule has no
  ledger: it applies to every slice today. Fixtures may still sign sample
  envelopes from fixed seeds.

Both checks are tested in `core/__tests__/threatBoundaryDocs.test.ts`. The scan
is a tripwire, not a proof of absence: a reviewer still reads the section
against the code.

## What "done" means

```bash
npm run check     # registry + lint + test + verify:features + build
```

All four must pass, plus:

- [ ] `npm run verify:features -- <slug>` reports OK
- [ ] Tests drive loading/error/empty through `@/core/testing/contract`
- [ ] Every error code has copy that says what to do next
- [ ] `a11y.test.tsx` covers at least two states
- [ ] `README.md` explains the non-obvious decision in the slice, not just what
      the tool does
- [ ] No secret key is ever accepted or echoed
- [ ] `README.md` has a complete `## Threat boundary` section (rule 15)
- [ ] Nothing outside `features/<slug>/` was modified

That last line is the important one. If your pull request touches a shared
file, something is wrong with the approach — say so in the issue rather than
working around it.

---

## Changing this contract

The reasons behind these rules are recorded as architecture decision records
in [adr/](./adr/README.md) — in particular
[0001](./adr/0001-vertical-feature-slices.md) (slices),
[0002](./adr/0002-generated-gitignored-registry.md) (generated registry),
[0003](./adr/0003-result-values-and-error-codes.md) (error codes),
[0004](./adr/0004-slice-local-fixtures-and-network-boundary-mocks.md)
(fixtures and MSW), [0005](./adr/0005-runtime-contract-migration-ledger.md)
(runtime states), [0006](./adr/0006-shared-amount-and-date-formatting.md)
(amounts and dates) and [0007](./adr/0007-documented-read-only-threat-boundaries.md)
(threat boundaries).

A pull request that changes this document — a rule, the layout, or what
`verify:features` enforces — must add a new ADR or supersede an existing one in
the same pull request. See [adr/README.md](./adr/README.md) for the format.
