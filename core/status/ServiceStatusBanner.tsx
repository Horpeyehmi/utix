import { formatDateTime } from "@/core/format/date";
import { StatusMessage, type StatusType } from "@/core/ui/StatusMessage";
import { copy } from "./copy";
import type { PublicServiceNotice, ServiceMode } from "./service-mode";

const TONE: Record<Exclude<ServiceMode, "normal">, StatusType> = {
  degraded: "warning",
  maintenance: "info",
  paused: "warning"
};

/**
 * Site-wide notice for a degraded, paused or maintenance mode. Renders nothing
 * in `normal`. It only ever receives a `PublicServiceNotice`, so there is no
 * internal field it could display by mistake.
 */
export function ServiceStatusBanner({ notice }: { notice: PublicServiceNotice }) {
  if (notice.mode === "normal") return null;
  const mode = notice.mode;

  return (
    <section aria-label={copy.banner.label} data-service-mode={mode} className="mx-auto max-w-7xl px-4 pt-4 sm:px-6 lg:px-8">
      <StatusMessage
        type={TONE[mode]}
        title={copy.banner.title[mode]}
        description={
          <>
            <p>{notice.message ?? copy.banner.fallback[mode]}</p>
            {notice.until ? (
              <p className="mt-1">
                {copy.banner.until} <time dateTime={notice.until}>{formatDateTime(notice.until)}</time>
              </p>
            ) : null}
            <p className="mt-1">
              <a href="/api/status" className="font-semibold underline">
                {copy.banner.statusLink}
              </a>
            </p>
          </>
        }
      />
    </section>
  );
}

/** Replaces a tool's panel while the service is paused, so no request is made. */
export function PausedToolNotice() {
  return <StatusMessage type="warning" title={copy.paused.title} description={copy.paused.description} data-service-mode="paused" />;
}
