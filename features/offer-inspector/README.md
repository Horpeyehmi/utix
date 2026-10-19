# Account Offers Inspector — #121

Read-only lookup of an account's open Stellar DEX offers at `/tools/offer-inspector`.
Every row shows the selling and buying asset (including issuer), the exact selling
amount, the rational price in buying units per selling unit, one base reserve, and
the account paying that reserve. Sponsored offers do not consume the owner's reserve.

`GET /accounts/{account_id}/offers?order=asc&limit=50` returns one page. Next-page
requests use the last validated paging token against the configured Horizon origin;
remote pagination links are never followed. Resubmitting the account returns to the
first page. An empty page is successful. Totals explicitly cover the displayed page.
The current reserve comes from `GET /ledgers?order=desc&limit=1`, rather than a fixed
0.5 XLM assumption. Offers and reserve data can change between requests.

Amounts use the shared exact stroop formatter. Prices remain `numerator/denominator`
because a rounded decimal can misrepresent a repeating price. Selling amounts explain
the funds committed to offers; reserve totals are separate from these liabilities.
Malformed amounts, prices, asset identifiers, sponsor addresses, cursors and reserve
responses fail with typed errors. Network changes and newer submissions discard
in-flight responses. Secret-key prefixes are rejected and cleared before form state
can retain them. This tool never signs or submits transactions.

Validation: `npx vitest run features/offer-inspector`,
`npm run verify:features -- offer-inspector`. The executable Playwright scenario in
`e2e/offer-inspector.spec.ts` exercises request failure, recovery and responsive results;
run it with a Playwright config whose test directory includes `features/`.

References: [Horizon offers](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/offers),
[sponsored reserves](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves).

Browser verification: `npx playwright test --config=features/offer-inspector/playwright.config.ts` runs desktop and mobile checks in the real app.
