import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NetworkProvider, useNetwork } from "@/core/network/NetworkProvider";
import { createIsolatedStorage } from "@/core/testing/render";
import { withMswHandlers, http, HttpResponse, delay } from "@/core/testing/msw";
import { useSponsorshipPlanner } from "../hooks/useSponsorshipPlanner";
import { handlers } from "../msw/handlers";
import { rawInput, secretSeed } from "../fixtures/sponsorshipPlanner.fixture";
const server = withMswHandlers(...handlers);
function wrapper({ children }: { children: ReactNode }) { return <NetworkProvider initialNetwork="testnet" storage={createIsolatedStorage()}>{children}</NetworkProvider>; }
describe("useSponsorshipPlanner", () => {
  it("does not hold rejected secret input", async () => {
    const { result } = renderHook(useSponsorshipPlanner, { wrapper });
    await act(async () => { await result.current.submit({ ...rawInput, sponsor: secretSeed }); });
    expect(result.current.state).toEqual({ status: "error", code: "secret_key" });
    expect(JSON.stringify(result.current.state)).not.toContain(secretSeed);
  });
  it("ignores in-flight work after reset or invalid submission", async () => {
    server.use(http.get("*", async () => { await delay(100); return HttpResponse.json({}, { status: 503 }); }));
    const { result } = renderHook(useSponsorshipPlanner, { wrapper });
    let pending: Promise<void>;
    act(() => { pending = result.current.submit(rawInput); });
    act(() => result.current.reset());
    await act(async () => { await pending; });
    expect(result.current.state.status).toBe("idle");
    act(() => { pending = result.current.submit(rawInput); });
    await act(async () => { await result.current.submit({ ...rawInput, sponsor: "invalid" }); await pending; });
    expect(result.current.state).toEqual({ status: "error", code: "invalid_address" });
  });
  it("hides old results across a network round trip", async () => {
    const { result } = renderHook(() => ({ tool: useSponsorshipPlanner(), network: useNetwork() }), { wrapper });
    await act(async () => { await result.current.tool.submit(rawInput); });
    await waitFor(() => expect(result.current.tool.state.status).toBe("success"));
    act(() => result.current.network.setNetwork("mainnet"));
    expect(result.current.tool.state.status).toBe("idle");
    act(() => result.current.network.setNetwork("testnet"));
    expect(result.current.tool.state.status).toBe("idle");
  });
});
