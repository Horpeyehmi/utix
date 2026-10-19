"use client";

import { Card } from "@/core/ui/Card";
import { SkeletonRows } from "@/core/ui/Skeleton";
import { StatusMessage } from "@/core/ui/StatusMessage";
import { useMultisigAnalyzer } from "../hooks/useMultisigAnalyzer";
import { copy, errorCopy } from "../copy";
import { MultisigAnalyzerForm } from "./MultisigAnalyzerForm";
import { MultisigAnalyzerResult } from "./MultisigAnalyzerResult";
import { MultisigAnalyzerEmptyState } from "./MultisigAnalyzerEmptyState";

export function MultisigAnalyzerPanel() {
  const { state, submit } = useMultisigAnalyzer();
  return <div className="space-y-5">
    <Card><MultisigAnalyzerForm onSubmit={submit} pending={state.status === "loading"} /></Card>
    {state.status === "idle" && <MultisigAnalyzerEmptyState />}
    {state.status === "loading" && <Card>
      <p className="sr-only" role="status">{copy.loading}</p>
      <SkeletonRows rows={4} />
    </Card>}
    {state.status === "error" && <StatusMessage type="error"
      title={errorCopy[state.code].title} description={errorCopy[state.code].description} />}
    {state.status === "success" && <MultisigAnalyzerResult result={state.result} />}
  </div>;
}
