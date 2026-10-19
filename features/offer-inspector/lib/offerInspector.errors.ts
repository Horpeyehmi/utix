import { classifyHorizonError } from "@/core/horizon/errors";
import { isTimeoutError } from "@/core/horizon/request";
import { InvalidResponse } from "./horizon";
import type { OfferInspectorErrorCode } from "../types";

export function toOfferInspectorErrorCode(error: unknown): OfferInspectorErrorCode {
  if (error instanceof InvalidResponse) return "invalid_response";
  if (isTimeoutError(error)) return "timeout";
  const { code } = classifyHorizonError(error);
  if (code === "not_found") return "account_not_found";
  if (code === "rate_limited" || code === "timeout" || code === "network_unavailable") return code;
  return "request_failed";
}
