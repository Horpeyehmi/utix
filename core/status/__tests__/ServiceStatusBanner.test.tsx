import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { expectNoAxeViolations } from "@/core/testing/axe";
import { copy } from "../copy";
import { PausedToolNotice, ServiceStatusBanner } from "../ServiceStatusBanner";
import { toPublicServiceNotice, type PublicServiceNotice, type ServiceModeState } from "../service-mode";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const UNTIL = "2026-03-10T13:00:00.000Z";

function notice(overrides: Partial<ServiceModeState> = {}): PublicServiceNotice {
  return toPublicServiceNotice(
    {
      mode: "maintenance",
      message: "Upgrading the indexer.",
      since: "2026-03-10T11:00:00.000Z",
      until: UNTIL,
      reason: "change:chg-7",
      changedBy: "maintainer-ada-42",
      ...overrides
    },
    NOW
  );
}

describe("ServiceStatusBanner", () => {
  it("renders nothing in normal mode", () => {
    const { container } = render(<ServiceStatusBanner notice={notice({ mode: "normal" })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once the window has passed", () => {
    const expired = toPublicServiceNotice({ mode: "paused", message: null, since: null, until: UNTIL }, Date.parse(UNTIL));
    const { container } = render(<ServiceStatusBanner notice={expired} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["degraded", "maintenance", "paused"] as const)("announces %s with its title and the operator's message", (mode) => {
    render(<ServiceStatusBanner notice={notice({ mode })} />);
    const region = screen.getByRole("region", { name: copy.banner.label });
    expect(region).toHaveAttribute("data-service-mode", mode);
    expect(screen.getByRole("status")).toHaveTextContent(copy.banner.title[mode]);
    expect(screen.getByText("Upgrading the indexer.")).toBeInTheDocument();
  });

  it("falls back to generic copy when there is no safe message", () => {
    render(<ServiceStatusBanner notice={notice({ mode: "paused", message: null })} />);
    expect(screen.getByText(copy.banner.fallback.paused)).toBeInTheDocument();
  });

  it("shows the expected end as a machine-readable time and links the status API", () => {
    render(<ServiceStatusBanner notice={notice()} />);
    expect(screen.getByText(copy.banner.until).querySelector("time")).toHaveAttribute("datetime", UNTIL);
    expect(screen.getByRole("link", { name: copy.banner.statusLink })).toHaveAttribute("href", "/api/status");
  });

  it("never renders an internal field", () => {
    const { container } = render(<ServiceStatusBanner notice={notice()} />);
    expect(container.textContent).not.toContain("chg-7");
    expect(container.textContent).not.toContain("maintainer-ada-42");
  });

  it("has no axe violations in the degraded and paused states", async () => {
    const degraded = render(<ServiceStatusBanner notice={notice({ mode: "degraded" })} />);
    await expectNoAxeViolations(degraded.container);
    degraded.unmount();

    const paused = render(<ServiceStatusBanner notice={notice({ mode: "paused", until: null })} />);
    await expectNoAxeViolations(paused.container);
  });
});

describe("PausedToolNotice", () => {
  it("explains that no request was made", async () => {
    const { container } = render(<PausedToolNotice />);
    expect(screen.getByRole("status")).toHaveTextContent(copy.paused.title);
    expect(screen.getByText(copy.paused.description)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
