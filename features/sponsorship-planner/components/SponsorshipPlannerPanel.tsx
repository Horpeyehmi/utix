"use client";

import { Card } from "@/core/ui/Card";
import { SkeletonRows } from "@/core/ui/Skeleton";
import { StatusMessage } from "@/core/ui/StatusMessage";
import { useSponsorshipPlanner } from "../hooks/useSponsorshipPlanner";
import { copy, errorCopy } from "../copy";
import { SponsorshipPlannerForm } from "./SponsorshipPlannerForm";
import { SponsorshipPlannerResult } from "./SponsorshipPlannerResult";
import { SponsorshipPlannerEmptyState } from "./SponsorshipPlannerEmptyState";

export function SponsorshipPlannerPanel() {
  const { state, submit } = useSponsorshipPlanner();
  return <div className="space-y-5">
    <Card><SponsorshipPlannerForm onSubmit={submit} pending={state.status === "loading"} /></Card>
    {state.status === "idle" && <SponsorshipPlannerEmptyState />}
    {state.status === "loading" && <Card>
      <p className="sr-only" role="status">{copy.loading}</p>
      <SkeletonRows rows={4} />
    </Card>}
    {state.status === "error" && <StatusMessage type="error"
      title={errorCopy[state.code].title} description={errorCopy[state.code].description} />}
    {state.status === "success" && <SponsorshipPlannerResult result={state.result} />}
  </div>;
}
