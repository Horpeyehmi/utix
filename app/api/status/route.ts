import { buildStatusResponse } from "@/core/status/service-config";

// Contributor diagnostics: local setup and dependency failures surface as a
// structured status payload so the route itself never throws on bad config.
export const runtime = "nodejs";

// Read the environment and the clock per request, never at build time.
export const dynamic = "force-dynamic";

/** Public, read-only status: the service notice plus the schema-backed feed. */
export function GET(): Response {
  const response = buildStatusResponse(process.env, Date.now());
  return Response.json(response.body, { status: response.status, headers: response.headers });
}
