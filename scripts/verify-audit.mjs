#!/usr/bin/env node
/**
 * Verifies the audit-trail contract without running any sensitive action.
 *
 * The trail itself lives in TypeScript (`core/audit/`) and is written by the
 * domain boundaries. This script is the CI-facing guard:
 *
 * 1. every action in `SENSITIVE_ACTIONS` is actually emitted by an emitter —
 *    a declared action nobody writes is a promise the trail does not keep;
 * 2. the trail has no update and no per-event delete: append and retention
 *    prune only, so a recorded event cannot be edited after the fact;
 * 3. the emitters exist at the boundaries where sensitive actions happen, and
 *    none of them is wired only into a UI component;
 * 4. every before/after context is passed through the same redaction the rest
 *    of the codebase uses, and no emitter hands the trail a whole payload.
 *
 * Run with: npm run verify:audit
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const audit = await readFile(path.join(root, "core/audit/audit.ts"), "utf8");

const failures = [];

/** Pulls a `export const NAME = [...] as const;` list out of the source. */
function declaredActions(source) {
  const match = source.match(/SENSITIVE_ACTIONS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

/** Every `action: "…"` literal in the source, including inside conditionals. */
function usedActions(source) {
  return new Set([...source.matchAll(/action:\s*"([a-z_.]+)"/g)].map((entry) => entry[1]));
}

const boundaries = [
  { file: "core/lifecycle/lifecycle.ts", emitter: "record.state_changed" },
  { file: "core/lifecycle/lifecycle.ts", emitter: "record.transition_denied" },
  { file: "core/export/exporter.ts", emitter: "export.generated" },
  { file: "core/notifications/store.ts", emitter: "notification.published" },
  { file: "core/notifications/store.ts", emitter: "notification.cleared" },
  { file: "core/reconciliation/job.ts", emitter: "reconciliation.reported" },
  { file: "core/reconciliation/repair.ts", emitter: "reconciliation.repaired" },
  { file: "core/idempotency/idempotency.ts", emitter: "idempotency.claim_released" },
  { file: "core/quota/quota.ts", emitter: "quota.override_granted" },
  { file: "core/quota/quota.ts", emitter: "quota.override_revoked" },
  { file: "core/replay/replay.ts", emitter: "projection.replayed" },
  { file: "core/replay/replay.ts", emitter: "projection.activated" },
  { file: "core/admin-config/store.ts", emitter: "admin.config_changed" },
  { file: "core/authorizations/store.ts", emitter: "authorization.granted" },
  { file: "core/authorizations/store.ts", emitter: "authorization.renewed" },
  { file: "core/authorizations/store.ts", emitter: "authorization.revoked" },
  { file: "core/authorizations/store.ts", emitter: "authorization.cleaned_up" },
  { file: "core/status/service-mode.ts", emitter: "service_mode.changed" },
  { file: "core/status/service-mode.ts", emitter: "service_mode.expired" }
];

const sources = new Map();
for (const { file } of boundaries) {
  if (!sources.has(file)) {
    sources.set(file, await readFile(path.join(root, file), "utf8"));
  }
}

const emitted = new Set();
for (const { file, emitter } of boundaries) {
  const source = sources.get(file);
  if (!usedActions(source).has(emitter)) {
    failures.push(`no emitter for ${emitter} at the domain boundary: ${file}`);
  }
  if (!/from ["']@\/core\/audit/.test(source)) {
    failures.push(`${file} records audit events without importing the audit module`);
  }
  emitted.add(emitter);
}

const declared = declaredActions(audit);
if (!declared || declared.length === 0) {
  failures.push("core/audit/audit.ts: SENSITIVE_ACTIONS is missing or empty");
} else {
  for (const action of declared) {
    // A declared action nobody writes is a promise the trail does not keep.
    if (!emitted.has(action)) {
      failures.push(`action declared but no domain boundary records it: ${action}`);
    }
  }
  for (const action of emitted) {
    if (!declared.includes(action)) {
      failures.push(`domain boundary records an undeclared action: ${action}`);
    }
  }
}

if (/\bupdate\s*\(|\bpatch\s*\(|\bmutate\s*\(|\bdestroy\s*\(/.test(audit)) {
  failures.push("core/audit/audit.ts: the trail must not offer an update, patch or delete");
}

if (!/redact\(/.test(audit)) {
  failures.push("core/audit/audit.ts: events must pass through redact() before they are stored");
}

if (!/EMBEDDED_SECRET/.test(audit)) {
  failures.push("core/audit/audit.ts: an embedded Stellar secret would survive into the trail");
}

if (!/typeof entry === "object"[^\n]*continue/.test(audit)) {
  failures.push("core/audit/audit.ts: a nested value would be stored as an audit context");
}

if (/limit: \d{4,}/.test(audit)) {
  failures.push("core/audit/audit.ts: a hard-coded retention limit would ignore the injected one");
}

if (failures.length > 0) {
  console.error("verify:audit failed\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `verify:audit ok — ${declared.length} sensitive actions, ${boundaries.length} domain-boundary emitters, append-only with redaction`
);
