# Trustline Checker

Answers one question precisely: does this account hold a trustline to this
asset code from this issuer?

## How it works

A Stellar asset is identified by the pair `(code, issuer)`, not by the code
alone. Two different issuers can both mint "USDC", and trusting one says
nothing about the other — which is why the issuer field is required and why a
wrong issuer is the most common source of a confusing "no trustline" answer.

`findTrustline` handles that directly: when the exact pair is not found but the
account *does* trust the same code from someone else, the result carries those
issuers so the UI can show them instead of a dead end.

Asset codes are compared case-insensitively (users type `usdc`) while the
ledger's own casing is reported back.

## Validation

Every validation failure carries the field that caused it, so the form can set
`aria-invalid` and render the message against the right input rather than in a
single anonymous banner. `accountId === issuerId` is rejected outright: an
issuing account never holds a trustline to its own asset.

## Safety

Trustlines are public ledger data. This tool is read-only and never creates,
modifies or removes a trustline.

## Threat boundary

- **Data sources:** three form fields (account id, asset code, issuer id) and
  the public account record Horizon returns for the selected network. Nothing
  is read from or written to browser storage.
- **Outbound requests:** one `GET {horizon}/accounts/{accountId}` per check,
  through `horizonServer(network).loadAccount` in `lib/trustlineChecker.ts`,
  to `horizon-testnet.stellar.org` or `horizon.stellar.org`. The URL carries
  only the public account id; the asset code and issuer are matched locally.
- **Cannot sign or submit:** `parseTrustlineInput` accepts only `G…` public
  keys, so a pasted `S…` secret is rejected as `invalid_account` before any
  request (`__tests__/schema.test.ts`). The slice never calls a signing or
  submission API, which `npm run verify:features` enforces by scanning its
  runtime sources, and `loadAccount` is a read-only Horizon endpoint.
