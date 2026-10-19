import { describe, expect, it } from "vitest";
import { parseSponsorshipPlannerInput } from "../schema";
import { rawInput, secretSeed } from "../fixtures/sponsorshipPlanner.fixture";
describe("sponsorship input", () => {
  it("parses counts", () => expect(parseSponsorshipPlannerInput(rawInput).ok).toBe(true));
  it.each(["-1", "1.5", "10001", "1e3", "", "2,000"])("rejects invalid count %s", (count) => expect(parseSponsorshipPlannerInput({ ...rawInput, counts: { ...rawInput.counts, offers: count } })).toEqual({ ok: false, code: "invalid_count" }));
  it("rejects self sponsorship", () => expect(parseSponsorshipPlannerInput({ ...rawInput, sponsor: rawInput.accountId })).toEqual({ ok: false, code: "same_account" }));
  it("rejects embedded secrets in an address", () => expect(parseSponsorshipPlannerInput({ ...rawInput, accountId: `prefix${secretSeed}suffix` })).toEqual({ ok: false, code: "secret_key" }));
  it.each(["sponsor", "accountId"] as const)("rejects secrets in either address", (key) => expect(parseSponsorshipPlannerInput({ ...rawInput, [key]: secretSeed })).toEqual({ ok: false, code: "secret_key" }));
});
