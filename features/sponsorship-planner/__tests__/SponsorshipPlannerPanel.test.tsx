import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderFeatureSlice } from "@/core/testing/contract";
import { withMswHandlers, http, HttpResponse, delay } from "@/core/testing/msw";
import { SponsorshipPlannerPanel } from "../components/SponsorshipPlannerPanel";
import { copy } from "../copy";
import { handlers } from "../msw/handlers";
import { secretSeed } from "../fixtures/sponsorshipPlanner.fixture";
import { fillForm } from "./helpers";
const server = withMswHandlers(...handlers);

describe("SponsorshipPlanner runtime contract", () => {
  it("shows idle, loading and a usable network failure", async () => {
    server.use(http.get("*", async () => { await delay(150); return HttpResponse.json({}, { status: 503 }); }));
    const slice = renderFeatureSlice("sponsorship-planner", <SponsorshipPlannerPanel />);
    slice.expectEmptyState();
    fillForm();
    await slice.user.click(screen.getByRole("button", { name: copy.submit }));
    slice.expectLoadingState();
    await slice.waitForState("error");
    slice.expectErrorState();
  });
  it("renders a result through the real request boundary", async () => {
    const slice = renderFeatureSlice("sponsorship-planner", <SponsorshipPlannerPanel />);
    fillForm();
    await slice.user.click(screen.getByRole("button", { name: copy.submit }));
    expect(await screen.findByRole("heading", { name: copy.resultTitle })).toBeInTheDocument();
  });
  it("clears pasted secrets without echoing them", () => {
    const slice = renderFeatureSlice("sponsorship-planner", <SponsorshipPlannerPanel />);
    fireEvent.change(screen.getByLabelText(copy.sponsor), { target: { value: secretSeed } });
    expect(screen.getByLabelText(copy.sponsor)).toHaveValue("");
    expect(slice.container.innerHTML).not.toContain(secretSeed);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
