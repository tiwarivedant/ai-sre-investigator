"use client";

import { useEffect, useState } from "react";
import type { TraceStep } from "@/lib/types";
import type { RunProgress } from "@/lib/client/useInvestigation";
import { runReadout } from "@/lib/client/progress";

/** What the agent is doing, in plain language, from its latest trace entry in this run. */
export function currentActivity(steps: TraceStep[], baseStep: number): string {
  const last = [...steps].reverse().find((t) => t.step > baseStep && (t.tool || t.label));
  if (!last) return "Reading the evidence…";
  if (last.label === "budget") return "Writing the brief…";
  if (last.label === "retry") return "Waiting to retry the model…";
  if (last.label === "stopped") return "Stopping…";
  const a = (last.args ?? {}) as Record<string, unknown>;
  switch (last.tool) {
    case "get_timeline":
      return "Reading the timeline…";
    case "search_logs":
      return `Searching ${a.service ? `${a.service} ` : ""}logs…`;
    case "get_alerts":
      return "Checking alerts…";
    case "get_changes":
      return "Checking deploys and config changes…";
    case "get_metrics":
      return "Reading metrics…";
    case "get_service_context":
      return `Looking up ${a.service ?? "the service"}…`;
    case "search_knowledge":
      return "Searching runbooks and past incidents…";
    case "get_evidence":
      return "Opening evidence…";
    case "update_investigation":
      return "Writing the brief…";
    case "finalize":
      return "Finishing up…";
    default:
      return "Working…";
  }
}

export function RunPill({
  steps,
  progress,
  followUp,
  onStop,
}: {
  steps: TraceStep[];
  progress: RunProgress | null;
  followUp: boolean;
  onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const readout = progress ? runReadout(steps, progress, true, now) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="run-pill"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-full border border-sky-400/30 bg-sky-500/10 py-1.5 pr-1.5 pl-3 text-sm"
    >
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-sky-300" />
      </span>
      <span className="font-medium text-sky-100">
        {followUp ? "Following up" : "Investigating"}
        {readout && (
          <span className="font-mono text-xs text-sky-200/80 tabular-nums">
            {" "}
            · Turn {readout.turn}/{readout.maxTurns} · {readout.elapsedS}s
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sky-200/80" data-testid="run-activity">
        {stopping ? "Stopping…" : currentActivity(steps, progress?.baseStep ?? 0)}
      </span>
      <button
        type="button"
        disabled={stopping}
        onClick={() => {
          setStopping(true);
          onStop();
        }}
        title="Stop the agent and keep the brief so far"
        className="shrink-0 rounded-full border border-zinc-600 bg-zinc-900 px-3 py-0.5 text-xs text-zinc-200 hover:border-zinc-400 disabled:opacity-50"
      >
        Stop
      </button>
    </div>
  );
}
