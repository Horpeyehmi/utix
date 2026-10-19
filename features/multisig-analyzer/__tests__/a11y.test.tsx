import { describe, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderFeature } from "@/core/testing/render";
import { expectNoAxeViolations } from "@/core/testing/axe";
import { withMswHandlers } from "@/core/testing/msw";
import { MultisigAnalyzerPanel } from "../components/MultisigAnalyzerPanel";
import { handlers } from "../msw/handlers";
import { copy } from "../copy";
import { fillForm } from "./helpers";
withMswHandlers(...handlers);
describe("MultisigAnalyzer accessibility", () => {
  it("passes in idle", async () => {
    const { container } = renderFeature(<MultisigAnalyzerPanel />);
    await expectNoAxeViolations(container);
  });
  it("passes with a real result", async () => {
    const { container, user } = renderFeature(<MultisigAnalyzerPanel />);
    fillForm();
    await user.click(screen.getByRole("button", { name: copy.submit }));
    await screen.findByRole("heading", { name: copy.resultTitle });
    await expectNoAxeViolations(container);
  });
});
