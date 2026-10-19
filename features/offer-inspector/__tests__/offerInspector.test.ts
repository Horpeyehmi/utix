import { describe, expect, it } from "vitest";
import { withMswHandlers, http, HttpResponse } from "@/core/testing/msw";
import { runOfferInspector } from "../lib/offerInspector";
import { handlers } from "../msw/handlers";
import { accountId, offerJson, ledgerJson, validInput, secretSeed } from "../fixtures/offerInspector.fixture";
const server = withMswHandlers(...handlers);
const endpoint = `https://horizon-testnet.stellar.org/accounts/${accountId}/offers`;
describe("open offers", () => {
  it("keeps amounts, rational prices and sponsor identity exact", async () => {
    const result = await runOfferInspector(validInput, "testnet");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.offers[0].amount).toBe("900719925.4740993");
    expect(result.value.offers[0].numerator).toBe(1);
    expect(result.value.offers[0].denominator).toBe(3);
    expect(result.value.offers[0].sponsor).toBeUndefined();
    expect(result.value.offers[1].sponsor).toBeDefined();
    expect(result.value.nextCursor).toBeNull();
  });
  it("follows a validated cursor without trusting remote next URLs", async () => {
    const cursors: (string | null)[] = [];
    server.use(http.get(endpoint, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get("cursor"); cursors.push(cursor);
      const rows = cursor ? [offerJson("51")] : Array.from({ length: 50 }, (_, i) => offerJson(String(i + 1)));
      return HttpResponse.json({ _links: { next: { href: "https://evil.example/secrets" } }, _embedded: { records: rows } });
    }));
    const first = await runOfferInspector(validInput, "testnet");
    if (!first.ok) throw new Error(first.code);
    expect(first.value.nextCursor).toBe("50");
    const next = await runOfferInspector({ ...validInput, cursor: first.value.nextCursor! }, "testnet");
    expect(next.ok && next.value.offers[0].id).toBe("51");
    expect(cursors).toEqual([null, "50"]);
  });
  it("treats no open offers as a successful empty result", async () => {
    server.use(http.get(endpoint, () => HttpResponse.json({ _embedded: { records: [] } })));
    const result = await runOfferInspector(validInput, "testnet");
    expect(result.ok && result.value.offers).toEqual([]);
  });
  it.each([[404, "account_not_found"], [429, "rate_limited"], [503, "request_failed"]])("maps status %s", async (status, code) => {
    server.use(http.get(endpoint, () => HttpResponse.json({}, { status: status as number })));
    expect(await runOfferInspector(validInput, "testnet")).toEqual({ ok: false, code });
  });
  it.each([{}, { ...offerJson(), price_r: { n: 1, d: 0 } }, { ...offerJson(), amount: "NaN" }, { ...offerJson(), sponsor: secretSeed }, { ...offerJson(), paging_token: "0" }])("fails closed on malformed records", async (row) => {
    server.use(http.get(endpoint, () => HttpResponse.json({ _embedded: { records: [row] } })));
    expect(await runOfferInspector(validInput, "testnet")).toEqual({ ok: false, code: "invalid_response" });
  });
  it("does not guess a missing reserve", async () => {
    server.use(http.get("https://horizon-testnet.stellar.org/ledgers", () => HttpResponse.json({ ...ledgerJson, _embedded: { records: [] } })));
    expect(await runOfferInspector(validInput, "testnet")).toEqual({ ok: false, code: "invalid_response" });
  });
});
