import { StrKey } from "@stellar/stellar-sdk";
import { err, ok, type Result } from "@/core/result/result";
import { ENTRY_KINDS, type EntryKind, type SponsorshipPlannerInput, type SponsorshipPlannerRaw, type SponsorshipPlannerErrorCode } from "./types";

export function containsSecret(value: string): boolean { return /^S/i.test(value.trim()) || /S[A-Z2-7]{55}/.test(value); }

export function parseSponsorshipPlannerInput(raw: SponsorshipPlannerRaw): Result<SponsorshipPlannerInput, SponsorshipPlannerErrorCode> {
  const sponsor = raw.sponsor.trim(), accountId = raw.accountId.trim();
  if ([sponsor, accountId].some(containsSecret)) return err("secret_key");
  if (!sponsor || !accountId) return err("empty_input");
  if (![sponsor, accountId].every((value) => StrKey.isValidEd25519PublicKey(value))) return err("invalid_address");
  if (sponsor === accountId) return err("same_account");
  const counts = {} as Record<EntryKind, number>;
  for (const kind of ENTRY_KINDS) {
    const value = raw.counts[kind];
    if (!/^\d{1,5}$/.test(value) || Number(value) > 10000 || typeof raw.sponsored[kind] !== "boolean") return err("invalid_count");
    counts[kind] = Number(value);
  }
  if (typeof raw.sponsorAccount !== "boolean") return err("invalid_count");
  return ok({ sponsor, accountId, counts, sponsored: { ...raw.sponsored }, sponsorAccount: raw.sponsorAccount });
}
