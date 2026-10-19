# Multisig Signature Weight Analyzer — #125

At `/tools/multisig-analyzer`, paste a transaction envelope and the base G address
of its inner source. XDR decoding and cryptographic verification happen locally.
Only public source account addresses are requested from Horizon. The selected
network's passphrase determines the transaction hash.

The analyzer loads signers and thresholds once per distinct source, with bounded
request concurrency. It checks the transaction source's low threshold, each
operation's source and low/medium/high threshold, extra-signer preconditions, and
a fee-bump source's separate low threshold. Muxed sources resolve to their base
accounts. `setOptions` needs high weight when any signer or threshold field is
present, including a zero-valued change; other options require medium weight.

Ed25519 signatures are verified against the contents hash; matching four-byte
hints alone never count. Hash-preimage, preauthorized-transaction and signed-payload
keys are also verified. The signed-payload decoder reads the XDR payload length
explicitly because SDK 13's general signer decoder includes padding in the payload.
Each signer contributes once per check, and disabled signers contribute zero.
Even zero configured thresholds require a positive-weight authorization.

Results show verified available weight, exact shortfalls, and the eligible missing
signers for every authorization check. Any sufficient combination can supply the
missing weight. Signature consumption follows the protocol's signer-type order
and early stopping so duplicate or surplus signatures are identified as possible
`tx_bad_auth_extra` failures. Inner and outer signatures are kept separate.

This is envelope authorization analysis against current account snapshots. It
does not validate sequence numbers, operation effects, fees, balances, time bounds,
or Soroban contract authorization. Missing operation-source accounts produce a
typed lookup error, including accounts an earlier operation would create. Nothing
is signed or submitted. Secret keys are rejected and cleared; raw input is never
retained in the hook's error state. Network epoch changes discard stale work.

Validation: `npx vitest run features/multisig-analyzer`,
`npm run verify:features -- multisig-analyzer`. The executable Playwright scenario
in `e2e/multisig-analyzer.spec.ts` covers request failure, recovery and responsive results.

References: [signatures and multisig](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig),
[operation thresholds](https://developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations),
[Stellar Core signature consumption](https://github.com/stellar/stellar-core/blob/master/src/transactions/SignatureChecker.cpp).

Browser verification: `npx playwright test --config=features/multisig-analyzer/playwright.config.ts` runs desktop and mobile checks in the real app.
