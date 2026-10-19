import { runHorizonRequest } from "@/core/horizon/request";

export class InvalidResponse extends Error {}

/** Bound requests and keep untrusted Horizon JSON out of the domain types. */
export async function requestJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return runHorizonRequest(fetch(url, { signal }).then(async (response) => {
    if (!response.ok) throw { status: response.status };
    return response.json() as Promise<unknown>;
  }), { signal });
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidResponse();
  return value as Record<string, unknown>;
}

export function records(value: unknown): unknown[] {
  const rows = record(record(value)._embedded).records;
  if (!Array.isArray(rows)) throw new InvalidResponse();
  return rows;
}

export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new InvalidResponse();
  }
  return value;
}
