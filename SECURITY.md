# Security Policy

RevyHubX is a developer utility for public Stellar workflows. It must never ask for private keys, seed phrases, or wallet recovery material.

## Supported Version

Security fixes target the `main` branch.

## Reporting

Open a private security advisory or contact the maintainers before publicly disclosing an issue that could expose users, wallet data, or deployment credentials.

## Maintainer Checks

Before release or deployment, maintainers should run:

```bash
npm audit --audit-level=moderate
npm run lint
npm run test
npm run build
```

## Scope

- Public key validation and public Horizon lookups are in scope.
- Friendbot usage is testnet-only and has no real asset value.
- The app does not store wallet keys or submit signed transactions.
- `GET /api/status` and the site banner publish only an allow-listed public notice; operator messages containing secrets, tokens, credential URLs, internal addresses or stack frames are refused (see [docs/PUBLIC_STATUS.md](./docs/PUBLIC_STATUS.md)).

## Read-only threat boundaries

Every tool is an independently contributed slice under `features/`, so the
read-only promise is verified per slice rather than assumed:

- Each slice's `README.md` has a `## Threat boundary` section listing its
  **data sources**, its **outbound requests**, and the **proof that it cannot
  sign or submit** a transaction. See rule 15 in
  [docs/FEATURE_CONTRACT.md](./docs/FEATURE_CONTRACT.md) for the format and
  the reviewer checklist, and
  [features/trustline-checker/README.md](./features/trustline-checker/README.md)
  for a worked example.
- `npm run verify:features` (run in CI) fails a slice whose section is missing
  or unfinished, and fails any slice whose runtime code calls a signing or
  submission API. Slices written before the rule are tracked in
  `scripts/threat-boundary-migration.json` until they are documented.

When reviewing a security-relevant change, read the slice's threat boundary
against its `lib/` and `msw/handlers.ts`: every request the code makes should
be listed, and every listed request should be a public, read-only endpoint.
