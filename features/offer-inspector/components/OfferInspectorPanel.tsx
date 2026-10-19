"use client";

import { Card } from "@/core/ui/Card";
import { SkeletonRows } from "@/core/ui/Skeleton";
import { StatusMessage } from "@/core/ui/StatusMessage";
import { useOfferInspector } from "../hooks/useOfferInspector";
import { copy, errorCopy } from "../copy";
import { OfferInspectorForm } from "./OfferInspectorForm";
import { OfferInspectorResult } from "./OfferInspectorResult";
import { OfferInspectorEmptyState } from "./OfferInspectorEmptyState";

export function OfferInspectorPanel() {
  const { state, submit } = useOfferInspector();
  return <div className="space-y-5">
    <Card><OfferInspectorForm onSubmit={submit} pending={state.status === "loading"} /></Card>
    {state.status === "idle" && <OfferInspectorEmptyState />}
    {state.status === "loading" && <Card>
      <p className="sr-only" role="status">{copy.loading}</p>
      <SkeletonRows rows={4} />
    </Card>}
    {state.status === "error" && <StatusMessage type="error"
      title={errorCopy[state.code].title} description={errorCopy[state.code].description} />}
    {state.status === "success" && <OfferInspectorResult result={state.result} onNext={() => submit({ accountId: state.result.accountId, cursor: state.result.nextCursor ?? undefined })} />}
  </div>;
}
