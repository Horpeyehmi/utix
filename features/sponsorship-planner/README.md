# Sponsorship and Reserve Planner — #128

At `/tools/sponsorship-planner`, choose how many **new** trustlines, pool-share
trustlines, offers, additional signers and data entries to create. Each kind can
be paid by the sponsor or the sponsored account. A pool-share trustline requires
two reserve units; other listed subentries require one.

The planner reads both public accounts and the latest ledger's base reserve from
Horizon. A 404 for the sponsored account means a new account; a missing sponsor is
an error. Connection failures never imply account creation. The optional sponsorship
of the account's two base reserve units applies to new accounts only. Reassigning
existing sponsorships and claimable-balance sponsorship are outside this plan.

The existing minimum is `(2 + subentry_count + num_sponsoring - num_sponsored) * base`.
New sponsored units increase the sponsor's minimum. Unsponsored new units increase
the beneficiary's minimum. Both funding shortfalls include existing XLM selling
liabilities. A sponsor's available amount is its balance minus selling liabilities
and the projected minimum, so an underfunded sponsor is visible even when its
headline XLM balance looks adequate. All amounts use `BigInt` stroops.

The displayed plan excludes fees, new trading liabilities and asset funding. It is
a snapshot, not a funding guarantee. It never accepts or echoes secret keys, builds
an envelope, signs, or submits a transaction. Address checks happen before requests;
network epoch changes discard stale results. Malformed upstream balances, counters
and reserves return typed failures instead of guessed values.

Validation: `npx vitest run features/sponsorship-planner`,
`npm run verify:features -- sponsorship-planner`. The executable Playwright scenario
in `e2e/sponsorship-planner.spec.ts` covers failure, recovery and responsive results.

References: [Stellar sponsored reserve arithmetic](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves),
[liquidity pool reserves](https://developers.stellar.org/docs/learn/fundamentals/liquidity-on-stellar-sdex-liquidity-pools).

Browser verification: `npx playwright test --config=features/sponsorship-planner/playwright.config.ts` runs desktop and mobile checks in the real app.
