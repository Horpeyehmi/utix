# Ticket transfer risk and review — #173

This server-side domain workflow evaluates transfer risk before ownership changes.
It uses completed transfer history and committed attempts for rapid resale,
device changes, recipient concentration, late transfers and repeated attempts.
The policy in `policy.ts` is configurable through trusted server configuration.
Scores, signal names, fingerprints and thresholds are internal review data.

Use `requestTicketTransfer` inside `commitMutation`. A successful result can be
`completed`, `review_required`, `blocked` or `rejected`; **commit the returned state
for every successful result**, including queued and blocked outcomes. Read the
coarse outcome with `publicTransferStatus(state, id, authenticatedPrincipalId)`.
Only `completed` changes ownership and consumes the nonce. The public projection
uses stable codes and generic recovery text without exposing the rules.

```ts
const outcome = await commitMutation(cell, (state) =>
  requestTicketTransfer(state, transfer, {
    now: serverClock(),
    deviceId: authenticatedSession.deviceFingerprint,
    policy: serverRiskPolicy
  })
);
```

The principal, device fingerprint, clock and policy must come from authenticated
server context. Do not accept them from a request body or put domain state in
an attendee's response. There is no new public mutation route: this repository's
existing transfer implementation is a domain library, and the read-only Stellar
tool UI remains read-only. The sandbox demo is synthetic and independent.

`pendingTransferReviews` scopes the queue to the event's organizer or a maintainer.
`reviewTicketTransfer` accepts an authenticated organizer/maintainer, approve/reject,
and a nonempty machine-readable reason (`identity_verified`, for example). It
appends actor, reason, timestamp and outcome to `transferRisk.audit` in the same
immutable state. Review state and audit must be stored with tickets, history and
nonces in the same database transaction/CAS; an external API should serialize only
the public projection. The in-memory `StateCell` is the repository's reference
adapter, not cross-process durable storage.

Approvals bind all transfer amounts, parties, ID and nonce to the ticket's ownership
version. Retry the exact approved request to complete it. Every domain invariant
is checked again, and a newly hard-blocking risk still prevents completion. Pending
and rejected reviews cannot be bypassed by rotating request IDs or nonces. Rejected
or hard-blocked ownership versions stay held; clearing such a hold requires a
separate authorized remediation workflow and is deliberately not automatic.
Completed retries return the existing state without extra transfers or audit rows.
Colliding IDs/nonces with different requests fail with `idempotency_conflict`.
Completing one reviewed request closes competing pending requests for that version.

The original `transferTicket` entry point also enforces the risk gate and records
successful attempts; risky direct calls return `transfer_review_required` or
`transfer_blocked` in the structured violation. Use `requestTicketTransfer` when
a queued outcome must be persisted. Safe ownership acceptance now calls the same
gate and validates fees, current ownership, locks and nonce before settling its
proposal. It refuses risky acceptance without marking the proposal accepted.

Validation: `npx vitest run core/transfer-risk core/ownership
core/invariants/__tests__/mutations.concurrency.test.ts`. Tests cover normal,
queued, approved, rejected and blocked transfers; scoped queue/status access;
review audit; forged timestamps; nonce rotation; payload conflicts; stale approvals;
and concurrent idempotent retries.
