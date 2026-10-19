import { StrKey } from "@stellar/stellar-sdk";
import { err, ok, type Result } from "@/core/result/result";
import type { OfferInspectorRaw, OfferInspectorInput, OfferInspectorErrorCode } from "./types";

export function containsSecret(value: string): boolean { return /^S/i.test(value.trim()) || /S[A-Z2-7]{55}/.test(value); }

export function parseOfferInspectorInput(raw: OfferInspectorRaw): Result<OfferInspectorInput, OfferInspectorErrorCode> {
  const accountId = raw.accountId.trim();
  if (!accountId) return err("empty_input");
  if (containsSecret(accountId)) return err("secret_key");
  if (!StrKey.isValidEd25519PublicKey(accountId)) return err("invalid_address");
  if (raw.cursor !== undefined && !/^\d{1,20}$/.test(raw.cursor)) return err("invalid_cursor");
  return ok({ accountId, cursor: raw.cursor });
}
