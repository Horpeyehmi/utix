import { ListFilter } from "lucide-react";
import { EmptyState } from "@/core/ui/EmptyState";
import { copy } from "../copy";

export function OfferInspectorEmptyState() {
  return <EmptyState icon={ListFilter} title={copy.emptyTitle} description={copy.emptyDescription} />;
}
