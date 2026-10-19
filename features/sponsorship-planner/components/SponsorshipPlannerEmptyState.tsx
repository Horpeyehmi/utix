import { HandCoins } from "lucide-react";
import { EmptyState } from "@/core/ui/EmptyState";
import { copy } from "../copy";

export function SponsorshipPlannerEmptyState() {
  return <EmptyState icon={HandCoins} title={copy.emptyTitle} description={copy.emptyDescription} />;
}
