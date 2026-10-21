/**
 * Schema-backed public status feed (#184).
 *
 * `buildPublicStatusFeed` turns trusted internal state into the published
 * feed. It is a pure function of that state and the instant it is given, so a
 * feed is reproducible and incident and maintenance states move
 * deterministically with time:
 *
 * - only `public` items are published, and only the schema's own fields are
 *   copied, so diagnostics and internal notes cannot leak by accident;
 * - component ids on an incident or maintenance window are limited to published
 *   components, so an internal component is not revealed by reference;
 * - a maintenance window is `scheduled` before it starts, `in_progress` while it
 *   runs and `completed` afterwards, from the clock alone;
 * - the overall status is the worst of the published components, unresolved
 *   incidents and running maintenance.
 *
 * `validatePublicStatusFeed` is the schema. It accepts exactly the published
 * shape and nothing else, and `publishPublicStatusFeed` runs it over the
 * builder's output so a feed that does not validate is never published.
 */

import { err, ok, type Result } from "@/core/result/result";
import type { HealthIndicator, HealthStatus } from "@/core/health/types";
import {
  COMPONENT_STATUSES,
  INCIDENT_IMPACTS,
  INCIDENT_STATUSES,
  MAINTENANCE_STATES,
  OVERALL_STATUSES,
  PUBLIC_STATUS_SCHEMA_VERSION,
  type ComponentStatus,
  type IncidentImpact,
  type MaintenanceState,
  type OverallStatus,
  type PublicComponent,
  type PublicIncident,
  type PublicMaintenance,
  type PublicStatusFeed,
  type StatusFeedErrorCode,
  type TrustedComponent,
  type TrustedMaintenance,
  type TrustedStatusState
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a resolved incident or completed maintenance window stays in the feed. */
export const STATUS_HISTORY_MS = 7 * DAY_MS;

const COMPONENT_RANK: Record<ComponentStatus, OverallStatus> = {
  operational: "operational",
  degraded: "degraded",
  partial_outage: "partial_outage",
  major_outage: "major_outage",
  under_maintenance: "maintenance"
};

const IMPACT_RANK: Record<IncidentImpact, OverallStatus> = {
  minor: "degraded",
  major: "partial_outage",
  critical: "major_outage"
};

const HEALTH_TO_COMPONENT: Record<HealthStatus, ComponentStatus> = {
  healthy: "operational",
  degraded: "degraded",
  unhealthy: "major_outage"
};

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function worst(statuses: readonly OverallStatus[]): OverallStatus {
  let rank = 0;
  for (const status of statuses) rank = Math.max(rank, OVERALL_STATUSES.indexOf(status));
  return OVERALL_STATUSES[rank];
}

/**
 * The worse of two component statuses, by the same ranking the overall status
 * uses. Raising a component to `floor` never hides an outage it already has.
 */
export function worseComponentStatus(current: ComponentStatus, floor: ComponentStatus): ComponentStatus {
  const rank = (status: ComponentStatus) => OVERALL_STATUSES.indexOf(COMPONENT_RANK[status]);
  return rank(floor) > rank(current) ? floor : current;
}

/** The state of a maintenance window at `nowMs`, from the clock alone. */
export function maintenanceStateAt(window: Pick<TrustedMaintenance, "startsAt" | "endsAt">, nowMs: number): MaintenanceState {
  if (nowMs < Date.parse(window.startsAt)) return "scheduled";
  if (nowMs < Date.parse(window.endsAt)) return "in_progress";
  return "completed";
}

/**
 * Maps a health indicator to trusted state. The component is internal unless
 * the caller names the public id and name to publish it under; the indicator's
 * message and details stay in `diagnostics`.
 */
export function componentFromHealthIndicator(
  indicator: HealthIndicator,
  published?: { readonly id: string; readonly name: string }
): TrustedComponent {
  return {
    id: published?.id ?? indicator.name,
    name: published?.name ?? indicator.name,
    status: HEALTH_TO_COMPONENT[indicator.status],
    visibility: published ? "public" : "internal",
    diagnostics: { message: indicator.message, ...indicator.details }
  };
}

/** Builds the published feed for the instant `now`. */
export function buildPublicStatusFeed(state: TrustedStatusState, now: number | Date): PublicStatusFeed {
  const nowMs = typeof now === "number" ? now : now.getTime();

  const windows = state.maintenance
    .filter((entry) => entry.visibility === "public" && !entry.cancelled)
    .map((entry) => ({ entry, state: maintenanceStateAt(entry, nowMs) }));
  const running = windows.filter((window) => window.state === "in_progress");

  const publicComponents = state.components.filter((component) => component.visibility === "public");
  const publishedIds = new Set(publicComponents.map((component) => component.id));
  const underMaintenance = new Set(running.flatMap((window) => window.entry.componentIds));
  const publishedOnly = (ids: readonly string[]): string[] => [...new Set(ids)].filter((id) => publishedIds.has(id)).sort();

  const components: PublicComponent[] = publicComponents
    .map((component) => ({
      id: component.id,
      name: component.name,
      status: underMaintenance.has(component.id) ? ("under_maintenance" as const) : component.status
    }))
    .sort(byId);

  const incidentEntries = state.incidents.filter((incident) => {
    if (incident.visibility !== "public") return false;
    if (incident.status !== "resolved") return true;
    return nowMs - Date.parse(incident.resolvedAt ?? incident.updatedAt) <= STATUS_HISTORY_MS;
  });
  const incidents: PublicIncident[] = incidentEntries
    .map((incident) => ({
      id: incident.id,
      title: incident.title,
      summary: incident.summary,
      status: incident.status,
      impact: incident.impact,
      startedAt: incident.startedAt,
      updatedAt: incident.updatedAt,
      resolvedAt: incident.resolvedAt ?? null,
      componentIds: publishedOnly(incident.componentIds)
    }))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || byId(a, b));

  const maintenance: PublicMaintenance[] = windows
    .filter((window) => window.state !== "completed" || nowMs - Date.parse(window.entry.endsAt) <= STATUS_HISTORY_MS)
    .map(({ entry, state: windowState }) => ({
      id: entry.id,
      title: entry.title,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      state: windowState,
      componentIds: publishedOnly(entry.componentIds)
    }))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || byId(a, b));

  const status = worst([
    ...components.map((component) => COMPONENT_RANK[component.status]),
    ...incidentEntries.filter((incident) => incident.status !== "resolved").map((incident) => IMPACT_RANK[incident.impact]),
    ...(running.length > 0 ? (["maintenance"] as const) : [])
  ]);

  return {
    schemaVersion: PUBLIC_STATUS_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    status,
    components,
    incidents,
    maintenance
  };
}

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isIdList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isText);
}

/** `true` when `value` has exactly `keys`: nothing missing and nothing extra. */
function hasExactKeys(value: Fields, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => key in value);
}

function firstInvalid(items: unknown, check: (item: Fields) => boolean, path: string): string | undefined {
  if (!Array.isArray(items)) return path;
  const index = items.findIndex((item) => !isRecord(item) || !check(item));
  return index === -1 ? undefined : `${path}[${index}]`;
}

/**
 * Validates a value against the public schema. The error detail is the path of
 * the first invalid field, never the offending value.
 */
export function validatePublicStatusFeed(value: unknown): Result<PublicStatusFeed, StatusFeedErrorCode, string> {
  const invalid = (path: string) => err("invalid_status_feed" as const, path);
  if (!isRecord(value)) return invalid("$");
  if (!hasExactKeys(value, ["schemaVersion", "generatedAt", "status", "components", "incidents", "maintenance"])) {
    return invalid("$");
  }
  if (value.schemaVersion !== PUBLIC_STATUS_SCHEMA_VERSION) return invalid("schemaVersion");
  if (!isIso(value.generatedAt)) return invalid("generatedAt");
  if (!isOneOf(OVERALL_STATUSES, value.status)) return invalid("status");

  const component = firstInvalid(
    value.components,
    (item) =>
      hasExactKeys(item, ["id", "name", "status"]) &&
      isText(item.id) &&
      isText(item.name) &&
      isOneOf(COMPONENT_STATUSES, item.status),
    "components"
  );
  if (component) return invalid(component);

  const incident = firstInvalid(
    value.incidents,
    (item) =>
      hasExactKeys(item, [
        "id",
        "title",
        "summary",
        "status",
        "impact",
        "startedAt",
        "updatedAt",
        "resolvedAt",
        "componentIds"
      ]) &&
      isText(item.id) &&
      isText(item.title) &&
      isText(item.summary) &&
      isOneOf(INCIDENT_STATUSES, item.status) &&
      isOneOf(INCIDENT_IMPACTS, item.impact) &&
      isIso(item.startedAt) &&
      isIso(item.updatedAt) &&
      (item.resolvedAt === null || isIso(item.resolvedAt)) &&
      isIdList(item.componentIds),
    "incidents"
  );
  if (incident) return invalid(incident);

  const window = firstInvalid(
    value.maintenance,
    (item) =>
      hasExactKeys(item, ["id", "title", "startsAt", "endsAt", "state", "componentIds"]) &&
      isText(item.id) &&
      isText(item.title) &&
      isIso(item.startsAt) &&
      isIso(item.endsAt) &&
      isOneOf(MAINTENANCE_STATES, item.state) &&
      isIdList(item.componentIds),
    "maintenance"
  );
  if (window) return invalid(window);

  return ok(value as unknown as PublicStatusFeed);
}

/** Builds the feed and publishes it only if it validates against the schema. */
export function publishPublicStatusFeed(
  state: TrustedStatusState,
  now: number | Date
): Result<PublicStatusFeed, StatusFeedErrorCode, string> {
  return validatePublicStatusFeed(buildPublicStatusFeed(state, now));
}
