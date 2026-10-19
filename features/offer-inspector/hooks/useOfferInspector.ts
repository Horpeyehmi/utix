"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import { parseOfferInspectorInput } from "../schema";
import { runOfferInspector } from "../lib/offerInspector";
import type { OfferInspectorErrorCode, OfferInspectorRaw, OfferInspectorResult } from "../types";

export type OfferInspectorState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: OfferInspectorResult }
  | { status: "error"; code: OfferInspectorErrorCode };

export function useOfferInspector() {
  const { network, epoch } = useNetwork();
  const [held, setHeld] = useState({
    network, epoch, state: { status: "idle" } as OfferInspectorState
  });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [network, epoch]);
  const state: OfferInspectorState = held.network === network && held.epoch === epoch
    ? held.state : { status: "idle" };

  const submit = useCallback(async (raw: OfferInspectorRaw) => {
    controller.current?.abort();
    const parsed = parseOfferInspectorInput(raw);
    if (!parsed.ok) {
      setHeld({ network, epoch, state: { status: "error", code: parsed.code } });
      return;
    }
    const next = new AbortController();
    controller.current = next;
    setHeld({ network, epoch, state: { status: "loading" } });
    const result = await runOfferInspector(parsed.value, network, next.signal);
    if (next.signal.aborted) return;
    setHeld({ network, epoch, state: result.ok
      ? { status: "success", result: result.value }
      : { status: "error", code: result.code } });
  }, [network, epoch]);

  const reset = useCallback(() => {
    controller.current?.abort();
    setHeld({ network, epoch, state: { status: "idle" } });
  }, [network, epoch]);
  return { state, submit, reset };
}
