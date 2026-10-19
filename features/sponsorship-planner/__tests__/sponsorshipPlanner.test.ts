import { describe, expect, it } from "vitest";
import { withMswHandlers, http, HttpResponse } from "@/core/testing/msw";
import { runSponsorshipPlanner } from "../lib/sponsorshipPlanner";
import { handlers } from "../msw/handlers";
import { accountId, sponsor, validInput, accountJson } from "../fixtures/sponsorshipPlanner.fixture";
const server = withMswHandlers(...handlers);
const accountEndpoint = `https://horizon-testnet.stellar.org/accounts/${accountId}`;
const sponsorEndpoint = `https://horizon-testnet.stellar.org/accounts/${sponsor}`;
describe("sponsored reserve planning", () => {
  it("includes existing sponsorship, new pool trustlines, and liabilities", async () => {
    const result = await runSponsorshipPlanner(validInput, "testnet");
    if (!result.ok) throw new Error(result.code);
    expect(result.value).toMatchObject({ sponsoredUnits: 4, sponsorCostStroops: "20000000", sponsorMinimumStroops: "50000000", sponsorAvailableStroops: "120000000", sponsorShortfallStroops: "0", accountMinimumStroops: "35000000", accountShortfallStroops: "0" });
  });
  it("accounts for an underfunded sponsor rather than using its headline balance", async () => {
    server.use(http.get(sponsorEndpoint, () => HttpResponse.json(accountJson(sponsor, "7", "3"))));
    const result = await runSponsorshipPlanner(validInput, "testnet");
    expect(result.ok && result.value.sponsorShortfallStroops).toBe("10000000");
  });
  it("funds the unsponsored part of a new account", async () => {
    server.use(http.get(accountEndpoint, () => HttpResponse.json({}, { status: 404 })));
    const result = await runSponsorshipPlanner(validInput, "testnet");
    expect(result.ok && result.value).toMatchObject({ newAccount: true, sponsorCostStroops: "20000000", accountMinimumStroops: "15000000", accountShortfallStroops: "15000000" });
  });
  it("includes both new account base reserves when sponsored", async () => {
    server.use(http.get(accountEndpoint, () => HttpResponse.json({}, { status: 404 })));
    const result = await runSponsorshipPlanner({ ...validInput, sponsorAccount: true }, "testnet");
    expect(result.ok && result.value).toMatchObject({ sponsoredUnits: 6, sponsorCostStroops: "30000000", accountMinimumStroops: "5000000" });
  });
  it("does not silently reassign an existing account base", async () => expect(await runSponsorshipPlanner({ ...validInput, sponsorAccount: true }, "testnet")).toEqual({ ok: false, code: "existing_account_base" }));
  it("requires a funded sponsor even when the recipient is new", async () => {
    server.use(http.get(sponsorEndpoint, () => HttpResponse.json({}, { status: 404 })));
    expect(await runSponsorshipPlanner(validInput, "testnet")).toEqual({ ok: false, code: "account_not_found" });
  });
  it("does not confuse recipient transport failure with a new account", async () => {
    server.use(http.get(accountEndpoint, () => HttpResponse.json({}, { status: 503 })));
    expect(await runSponsorshipPlanner(validInput, "testnet")).toEqual({ ok: false, code: "request_failed" });
  });
  it("rejects impossible sponsorship counters", async () => {
    server.use(http.get(accountEndpoint, () => HttpResponse.json({ ...accountJson(accountId), num_sponsored: 100 })));
    expect(await runSponsorshipPlanner(validInput, "testnet")).toEqual({ ok: false, code: "invalid_response" });
  });
  it("preserves balances above Number precision", async () => {
    server.use(http.get(sponsorEndpoint, () => HttpResponse.json(accountJson(sponsor, "900719925.4740993", "0"))));
    const result = await runSponsorshipPlanner(validInput, "testnet");
    expect(result.ok && result.value.sponsorAvailableStroops).toBe("9007199204740993");
  });
});
