/**
 * Cross-resource dependency graph for impact analysis (#187).
 *
 * Resources (events, tickets, users, operations, external references) declare
 * what they depend on. `analyzeImpact` answers, read-only, "what is affected if
 * this resource changes?" by walking the graph from one resource and listing
 * direct and indirect dependents with their distance. Pass
 * `direction: "dependencies"` to walk the other way: what the resource relies on.
 *
 * Walks are breadth-first with a visited set, so cycles terminate and every
 * resource is reported once at its shortest distance. Dangling references are
 * reported rather than ignored, and restricted resources are redacted for
 * callers without `admin:config`.
 *
 * Operational edge cases and recovery behavior:
 * - Unauthorized callers (no `view:dashboard`) get `permission_denied` and no
 * graph data is returned, so nothing leaks about the topology.
 * - A root that is restricted is denied to callers without `admin:config`,
 * rather than returning a redacted root, to avoid revealing its existence.
 * - Unknown roots return `resource_not_found`; callers may retry after the
 * graph is reloaded. The function is pure and read-only, so retry is safe
 * and no rollback is needed.
 * - Duplicate node ids: the last occurrence wins in the lookup map. Callers
 * should dedupe before invoking; this is a data error, not a retry case.
 * - Self-loops and cycles through the root are reported in `cycles`, not
 * followed again, so the walk always terminates.
 * - Migration: the report shape is unchanged; `cycles`, `missingReferences`,
 * and `redactedCount` were already part of the contract.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission, type Permission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";

/** Needed to read impact analysis at all. */
export const IMPACT_READ_PERMISSION: Permission = "view:dashboard";

/** Needed to see restricted resources un-redacted. */
export const IMPACT_RESTRICTED_PERMISSION: Permission = "admin:config";

export const REDACTED_KIND = "redacted";

export interface DependencyNode {
  readonly id: string;
  /** e.g. `event`, `ticket`, `user`, `operation`, `external_reference`. */
  readonly kind: string;
  /** Ids of the resources this one depends on. */
  readonly dependsOn: readonly string[];
  readonly restricted?: boolean;
}

export type ImpactDirection = "dependents" | "dependencies";

export type ImpactErrorCode = "permission_denied" | "resource_not_found";

export interface ImpactEntry {
  readonly id: string;
  readonly kind: string;
  /** 1 is a direct dependency; larger values are indirect. */
  readonly depth: number;
}

export interface MissingReference {
  /** The resource holding the dangling reference. */
  readonly from: string;
  readonly missingId: string;
}

export interface ImpactReport {
  readonly rootId: string;
  readonly direction: ImpactDirection;
  readonly direct: readonly ImpactEntry[];
  readonly indirect: readonly ImpactEntry[];
  /** Cycles that pass through the root, each starting and ending at it. */
  readonly cycles: readonly (readonly string[])[];
  readonly missingReferences: readonly MissingReference[];
  /** How many reported resources were hidden from this caller. */
  readonly redactedCount: number;
}

export function analyzeImpact(
  nodes: readonly DependencyNode[],
  rootId: string,
  auth: AuthContext,
  direction: ImpactDirection = "dependents"
): Result<ImpactReport, ImpactErrorCode> {
  if (!hasPermission(auth.role, IMPACT_READ_PERMISSION)) return err("permission_denied");

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root = byId.get(rootId);
  if (!root) return err("resource_not_found");
  const canSeeRestricted = hasPermission(auth.role, IMPACT_RESTRICTED_PERMISSION);
  if (root.restricted && !canSeeRestricted) return err("permission_denied");

  // Edges are stored as "depends on"; flip them to walk toward dependents.
  const edges = new Map<string, string[]>();
  for (const node of nodes) {
    for (const target of node.dependsOn) {
      const [from, to] = direction === "dependencies" ? [node.id, target] : [target, node.id];
      edges.set(from, [...(edges.get(from) ?? []), to]);
    }
  }
  const next = (id: string): string[] => (edges.get(id) ?? []).filter((to) => byId.has(to)).sort();

  const depths = new Map<string, number>([[rootId, 0]]);
  const parents = new Map<string, string>();
  const queue = [rootId];
  const cycles: string[][] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const to of next(current)) {
      if (to === rootId) {
        const chain: string[] = [];
        for (let step = current; step !== rootId; step = parents.get(step) as string) chain.push(step);
        cycles.push([rootId, ...chain.reverse(), rootId]);
      } else if (!depths.has(to)) {
        depths.set(to, (depths.get(current) ?? 0) + 1);
        parents.set(to, current);
        queue.push(to);
      }
    }
  }

  let redactedCount = 0;
  const aliases = new Map<string, string>();
  const reveal = (id: string): { id: string; kind: string } => {
    const node = byId.get(id);
    if (node?.restricted && !canSeeRestricted) {
      if (!aliases.has(id)) {
        aliases.set(id, `${REDACTED_KIND}:${aliases.size + 1}`);
        redactedCount += 1;
      }
      return { id: aliases.get(id) as string, kind: REDACTED_KIND };
    }
    return { id, kind: node?.kind ?? "unknown" };
  };

  const entries = [...depths.entries()]
    .filter(([id]) => id !== rootId)
    .sort(([a, depthA], [b, depthB]) => depthA - depthB || (a < b ? -1 : 1))
    .map(([id, depth]): ImpactEntry => ({ ...reveal(id), depth }));

  const missingReferences = [...depths.keys()].flatMap((id) =>
    (byId.get(id)?.dependsOn ?? [])
      .filter((target) => !byId.has(target))
      .map((missingId): MissingReference => ({ from: reveal(id).id, missingId }))
  );

  return ok({
    rootId,
    direction,
    direct: entries.filter((entry) => entry.depth === 1),
    indirect: entries.filter((entry) => entry.depth > 1),
    cycles: cycles.map((path) => path.map((id) => reveal(id).id)),
    missingReferences,
    redactedCount
  });
}
