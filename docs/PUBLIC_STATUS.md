# Public status feed

`core/status/` publishes a machine-readable view of protocol health, incidents
and maintenance windows for external users and maintainers, without exposing
internal diagnostics.

## Two shapes

- **Trusted state** (`TrustedStatusState`) is internal. Components may carry
  `diagnostics`, incidents and maintenance windows may carry `internalNotes`,
  and every item has a `visibility` of `public` or `internal`.
- **The public feed** (`PublicStatusFeed`) is the published schema. The builder
  copies only the schema's own fields, so nothing else can leak by accident.

## Schema (version `1.0.0`)

```jsonc
{
  "schemaVersion": "1.0.0",
  "generatedAt": "2026-03-10T12:00:00.000Z",
  "status": "operational | degraded | maintenance | partial_outage | major_outage",
  "components": [
    { "id": "api", "name": "Ticket API",
      "status": "operational | degraded | partial_outage | major_outage | under_maintenance" }
  ],
  "incidents": [
    { "id": "inc-1", "title": "...", "summary": "...",
      "status": "investigating | identified | monitoring | resolved",
      "impact": "minor | major | critical",
      "startedAt": "...", "updatedAt": "...", "resolvedAt": "... | null",
      "componentIds": ["api"] }
  ],
  "maintenance": [
    { "id": "mnt-1", "title": "...", "startsAt": "...", "endsAt": "...",
      "state": "scheduled | in_progress | completed", "componentIds": ["api"] }
  ]
}
```

`validatePublicStatusFeed(value)` is the schema: it accepts exactly this shape
(no missing and no extra fields, ISO-8601 instants, known enum values) and
returns `invalid_status_feed` with the path of the first invalid field.
`publishPublicStatusFeed(state, now)` builds the feed and runs it through that
validator, so a feed that does not validate is never published.

## Deterministic states

The feed is a pure function of the trusted state and the instant `now`:

- A maintenance window is `scheduled` before `startsAt`, `in_progress` until
  `endsAt`, and `completed` after. Its components show `under_maintenance`
  while it runs. Cancelled windows are never published.
- The overall `status` is the worst of the published components, unresolved
  incidents (`minor` is degraded, `major` partial outage, `critical` major
  outage) and running maintenance. An outage outranks maintenance.
- Resolved incidents and completed windows stay in the feed for 7 days.
- Lists are sorted (components by id, incidents newest first, windows by start),
  so identical input always produces an identical feed.

## What is filtered out

- Items with `visibility: "internal"`, and anything cancelled.
- `diagnostics` and `internalNotes`, always.
- Internal component ids: incident and window `componentIds` are limited to
  published components, so an internal component is not revealed by reference.
- Internal components never move the overall status.

`componentFromHealthIndicator(indicator, { id, name })` turns an entry of the
operational health summary (see [OPERATIONAL_HEALTH.md](./OPERATIONAL_HEALTH.md))
into a trusted component. Without a public `id` and `name` the component stays
internal; the indicator's message and details only ever land in `diagnostics`.

## Serving the feed

The module returns plain JSON-serializable data. `GET /api/status`
(`app/api/status/route.ts`) serves it together with the service-mode notice
described below. Loading incidents and maintenance windows from wherever
maintainers record them is left to the caller: pass them as the `trusted`
argument of `buildStatusResponse`.

## Service mode: degraded, paused, maintenance (#221)

The feed above reports what is *observed*. The service mode is what an
operator *declares*: one app-wide mode with a short public message, set
without a code change. It lives in `core/status/service-mode.ts` and
`core/status/service-config.ts`.

| Mode          | Meaning for users                                   | Published components | Overall feed status (at least) |
| ------------- | --------------------------------------------------- | -------------------- | ------------------------------ |
| `normal`      | Nothing to report. No banner.                       | unchanged            | unchanged                      |
| `degraded`    | Tools work but may be slow or fail intermittently.  | `degraded`           | `degraded`                     |
| `maintenance` | Planned work; some tools may be briefly unavailable. | `under_maintenance`  | `maintenance`                  |
| `paused`      | Kill switch: tool panels are not mounted, so no tool makes a request. | `major_outage` | `major_outage` |

Components are only ever *raised* to the mode's level, never lowered, so a
declared `degraded` never hides an observed outage. Internal components are
untouched.

### Configuring it

| Variable               | Value |
| ---------------------- | ----- |
| `UTIX_SERVICE_MODE`    | `normal` (default when unset), `degraded`, `paused`, `maintenance` (case-insensitive) |
| `UTIX_SERVICE_MESSAGE` | Optional public text, at most 280 characters |
| `UTIX_SERVICE_SINCE`   | Optional ISO-8601 instant (`2026-03-10T12:00:00.000Z`); a future value schedules the mode |
| `UTIX_SERVICE_UNTIL`   | Optional ISO-8601 instant; at and after it the mode is `normal` again |

These are server-side variables, deliberately not `NEXT_PUBLIC_*`: they are
read when a page or the API renders, never inlined into client JavaScript.

Programmatic changes (an admin tool, the rollout guard, a script) go through
`createServiceModeStore().change(actor, request)`. Only `maintainer` and
`system` actors may change the mode; a `user` is refused with
`service_mode_forbidden`. Every attempt, allowed or denied, is written to the
audit trail as `service_mode.changed` **before** the mode changes, with the
internal `reason` code (for example `incident:inc-42`) and the before/after
mode. The public message is not copied into the trail. If the trail rejects
the event, the mode does not change (`service_mode_audit_rejected`).

### Where it shows up

- **UI.** `AppShell` renders `ServiceStatusBanner` under the header in every
  non-normal mode: the operator's message, or generic copy if there is none, the
  expected end time, and a link to `/api/status`. While `paused`, the tool route
  renders `PausedToolNotice` instead of the tool's panel.
- **API.** `GET /api/status` returns `{ notice, feed }`: the notice below and
  the schema-`1.0.0` feed with the mode applied. It is rendered per request and
  sent with `Cache-Control: no-store`. If either part fails its schema, the
  route answers `503 { "error": "status_unavailable" }` and emits telemetry
  instead of publishing it.
- **Background.** `registerServiceModeJobs(framework, store)` registers the
  `status.expire_service_mode` worker job. When it runs after `until`, it
  returns a store-held mode to `normal` and records `service_mode.expired` from
  the system actor. Running it early or twice does nothing.

```jsonc
// notice, schema version 1.0.0 (validatePublicServiceNotice)
{ "schemaVersion": "1.0.0", "mode": "maintenance",
  "message": "Upgrading the indexer.", "since": "…", "until": "… | null" }
```

The feed's schema is unchanged. Existing consumers of the `1.0.0` feed keep
working and simply see component statuses that reflect the declared mode.

### Keeping secrets out

The notice is built only from its five public fields. The internal `reason`
and `changedBy` never leave the store. The message is operator-written text,
so `checkServiceMessage` **refuses** it, rather than scrubbing it, if it
contains any of these:

- a Stellar secret seed;
- a bearer token;
- credentials in a URL;
- a `secret=`, `token:` or `api_key=` style pair;
- a private, loopback or link-local address, or `localhost`;
- a stack frame such as `worker.ts:42`.

A half-redacted message is still a leak, and a refusal tells the operator
exactly what to fix.

### Failure modes and edge cases

| Situation | Behaviour | Signal |
| --- | --- | --- |
| `UTIX_SERVICE_MODE` is not a known value (e.g. a typo) | Published as `degraded` with generic copy, so the problem stays visible to users instead of being reported as `normal` | telemetry `status.service_mode_config`, `invalid_service_mode` |
| Message missing | Generic copy for the mode | none, this is allowed |
| Message unsafe or longer than 280 characters | Message dropped; mode kept; generic copy | `unsafe_service_message` / `service_message_too_long` |
| `SINCE`/`UNTIL` not ISO-8601 | That bound is ignored and the mode is open-ended | `invalid_service_window` |
| `UNTIL` not after `SINCE` | `UNTIL` ignored; mode is open-ended | `invalid_service_window` |
| `UNTIL` has passed | `normal` everywhere, from the clock alone | none |
| Feed or notice fails its own schema | `503 status_unavailable`, nothing partial is published | telemetry `status.publish` |
| A user actor tries to change the mode | Refused and audited as denied | `service_mode_forbidden` |
| Audit trail unavailable | Change refused, mode unchanged | `service_mode_audit_rejected` |

**Freshness.** The API is evaluated per request. Pages are statically rendered
and revalidated at most every 60 seconds (`revalidate` in `app/layout.tsx`).
So a `SINCE` or `UNTIL` boundary reaches the banner and the paused gate within
about a minute, while the API reflects it immediately. Changing a variable
itself needs a redeploy or restart on most hosts, Vercel included, which
rebuilds the pages.

### Runbook: entering, leaving and rolling back

1. **Enter a mode.** Set `UTIX_SERVICE_MODE`, a `UTIX_SERVICE_MESSAGE` written
   for the public, and preferably `UTIX_SERVICE_UNTIL`, so a forgotten mode
   lifts itself. Redeploy.
2. **Verify.** `curl -s https://<host>/api/status | jq .notice` should show
   the mode and message. If `message` is `null` when you set one, it was
   refused: check telemetry for `status.service_mode_config`, then reword it.
   The banner should appear on the next page load.
3. **Leave or roll back.** Set `UTIX_SERVICE_MODE=normal`, or unset it, and
   redeploy. `/api/status` should report `"mode": "normal"` and the banner
   disappears. Unsetting the variables is always a safe rollback: the default
   is `normal`, and no data or schema migration is involved.
4. **Emergency.** If a deploy is not possible, an already-set `UNTIL` still ends
   the mode on time. Plan pauses with an `UNTIL` for this reason.
5. **Roll back the code.** Reverting this change removes the banner, the
   paused gate and `/api/status`. The `1.0.0` feed and its consumers are
   unaffected.
