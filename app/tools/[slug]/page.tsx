import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findFeature, loadFeaturePanel } from "@/core/registry/registry";
import { featureSlugs, findManifest } from "@/core/registry/manifests";
import { FeatureShell } from "@/core/ui/FeatureShell";
import { currentServiceNotice } from "@/core/status/service-config";
import { PausedToolNotice } from "@/core/status/ServiceStatusBanner";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return featureSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { slug } = await params;
  const manifest = findManifest(slug);

  if (!manifest) return { title: "Tool not found" };

  return {
    title: `${manifest.title} — RevyHubX`,
    description: manifest.description,
    openGraph: {
      title: `${manifest.title} — RevyHubX`,
      description: manifest.description
    }
  };
}

/**
 * Single route for every tool.
 *
 * Feature slices are discovered from `features/` at build time, so adding a
 * tool never requires creating or editing a file under `app/`.
 */
export default async function ToolPage({ params }: RouteParams) {
  const { slug } = await params;
  const feature = findFeature(slug);

  if (!feature) notFound();

  const { manifest } = feature;

  // A pause is a kill switch: the panel is never mounted, so no tool can make
  // a request until the operator lifts it.
  if (currentServiceNotice().mode === "paused") {
    return (
      <FeatureShell manifest={manifest}>
        <PausedToolNotice />
      </FeatureShell>
    );
  }

  const loaded = await loadFeaturePanel(feature);

  if (!loaded.ok) {
    return (
      <FeatureShell manifest={manifest}>
        <div role="alert" data-feature-load-error={loaded.detail?.slug}>
          <p className="font-medium">This tool could not be loaded.</p>
          <p className="text-sm">
            A newer version may have been deployed or your connection dropped. Reload the page
            to try again.
          </p>
        </div>
      </FeatureShell>
    );
  }

  const Panel = loaded.value;

  return (
    <FeatureShell manifest={manifest}>
      <Panel />
    </FeatureShell>
  );
}
