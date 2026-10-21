import type { ServiceMode } from "./service-mode";

type ActiveMode = Exclude<ServiceMode, "normal">;

export const copy = {
  banner: {
    label: "Service status",
    title: {
      degraded: "Some tools are slower or less reliable than usual",
      maintenance: "Scheduled maintenance in progress",
      paused: "Tools are temporarily paused"
    } satisfies Record<ActiveMode, string>,
    // Shown when the operator gave no message, or one that failed the safety check.
    fallback: {
      degraded: "Results may take longer or fail intermittently. Retrying usually helps.",
      maintenance: "Some tools may be unavailable for a short time.",
      paused: "No tool will make a request until the pause is lifted. Please check back later."
    } satisfies Record<ActiveMode, string>,
    until: "Expected to end by",
    statusLink: "Machine-readable status"
  },
  paused: {
    title: "This tool is paused",
    description: "All tools are temporarily paused while the maintainers investigate. No request has been made."
  }
} as const;
