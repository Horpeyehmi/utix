# Deployment

This project is ready for Vercel's standard Next.js deployment flow.

## Vercel Setup

1. Import `https://github.com/RevenantLabs/RevyHubX` into Vercel.
2. Keep the framework preset as Next.js.
3. Keep the install command as `npm install` or Vercel's detected default.
4. Keep the build command as `npm run build`.
5. Deploy from the `main` branch.

## Environment Variables

The app works without custom variables because safe defaults are defined in code.

```env
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_HORIZON_TESTNET_URL=https://horizon-testnet.stellar.org
NEXT_PUBLIC_HORIZON_MAINNET_URL=https://horizon.stellar.org
NEXT_PUBLIC_APP_URL=https://your-vercel-domain.vercel.app
```

Use `NEXT_PUBLIC_STELLAR_NETWORK=testnet` for public demos.

### Service status (optional)

```env
UTIX_SERVICE_MODE=normal          # degraded | paused | maintenance
UTIX_SERVICE_MESSAGE=             # public text, at most 280 characters
UTIX_SERVICE_SINCE=               # ISO-8601, optional
UTIX_SERVICE_UNTIL=               # ISO-8601, optional; the mode lifts itself after it
```

These show a site-wide banner, pause every tool (`paused`), and drive
`GET /api/status`. Leave them unset in normal operation. See the runbook in
[PUBLIC_STATUS.md](./PUBLIC_STATUS.md#runbook-entering-leaving-and-rolling-back)
before using them in production. The in-app network switch can still query mainnet Horizon-backed tools.

## Pre-Deploy Checks

Run the same checks as CI:

```bash
npm audit --audit-level=moderate
npm run lint
npm run test
npm run build
```

## Common Issues

- `npm audit` fails: update dependencies or document the upstream advisory before deploying.
- Horizon requests fail in the browser: verify the selected network and Horizon URL.
- Friendbot fails: confirm the destination is a valid public key and remember Friendbot is testnet-only.
- Freighter network mismatch appears: switch either the app network selector or the Freighter extension network.
