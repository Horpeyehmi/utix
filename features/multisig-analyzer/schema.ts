import { StrKey } from "@stellar/stellar-sdk";
import { err, ok, type Result } from "@/core/result/result";
import type { MultisigAnalyzerRaw, MultisigAnalyzerInput, MultisigAnalyzerErrorCode } from "./types";

export function containsSecret(value: string): boolean { return /^S/i.test(value.trim()) || /S[A-Z2-7]{55}/.test(value); }
export function parseMultisigAnalyzerInput(raw: MultisigAnalyzerRaw): Result<MultisigAnalyzerInput, MultisigAnalyzerErrorCode> {
  const accountId = raw.accountId.trim();
  if (containsSecret(accountId) || containsSecret(raw.xdr)) return err("secret_key");
  if (!accountId || !raw.xdr.trim()) return err("empty_input");
  if (!StrKey.isValidEd25519PublicKey(accountId)) return err("invalid_address");
  if (raw.xdr.length > 200000) return err("input_too_large");
  const xdr = raw.xdr.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(xdr) || xdr.length % 4 !== 0) return err("invalid_xdr");
  return ok({ accountId, xdr });
}
