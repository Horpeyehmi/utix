"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import { parseSponsorshipPlannerInput } from "../schema";
import { runSponsorshipPlanner } from "../lib/sponsorshipPlanner";
import type { SponsorshipPlannerErrorCode, SponsorshipPlannerRaw, SponsorshipPlannerResult } from "../types";

export type SponsorshipPlannerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: SponsorshipPlannerResult }
  | { status: "error"; code: SponsorshipPlannerErrorCode };

export function useSponsorshipPlanner() {
  const { network, epoch } = useNetwork();
  const [held, setHeld] = useState({
    network, epoch, state: { status: "idle" } as SponsorshipPlannerState
  });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [network, epoch]);
  const state: SponsorshipPlannerState = held.network === network && held.epoch === epoch
    ? held.state : { status: "idle" };

  const submit = useCallback(async (raw: SponsorshipPlannerRaw) => {
    controller.current?.abort();
    const parsed = parseSponsorshipPlannerInput(raw);
    if (!parsed.ok) {
      setHeld({ network, epoch, state: { status: "error", code: parsed.code } });
      return;
    }
    const next = new AbortController();
    controller.current = next;
    setHeld({ network, epoch, state: { status: "loading" } });
    const result = await runSponsorshipPlanner(parsed.value, network, next.signal);
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
