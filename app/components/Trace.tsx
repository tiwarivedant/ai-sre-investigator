"use client";

import { useEffect, useRef, useState } from "react";
import type { TraceStep } from "@/lib/types";
import type { RunProgress } from "@/lib/client/useInvestigation";
import { runReadout } from "@/lib/client/progress";
import { chipLabel, RichText } from "./ui";

const LABEL: Record<NonNullable<TraceStep["label"]>, { title: string; style: string }> = {
  budget: { title: "Budget reminder", style: "border-amber-500/30 bg-amber-500/5 text-amber-200" },
  retry: { title: "Retry", style: "border-orange-500/30 bg-orange-500/5 text-orange-200" },
  stopped: { title: "Stopped", style: "border-red-500/30 bg-red-500/5 text-red-200" },
};

type Args = Record<string, unknown>;
const list = (xs: unknown, max = 3) => {
  const arr = (Array.isArray(xs) ? xs : []).map(String);
  return arr.slice(0, max).join(", ") + (arr.length > max ? ` +${arr.length - max}` : "");
};
const range = (a: Args) => (a.from || a.to ? ` ${a.from ?? "start"}–${a.to ?? "end"}` : "");

/** One plain-English line per tool call; the raw arguments stay one click away. */
export function describeCall(tool: string, a: Args = {}): string {
  switch (tool) {
    case "get_timeline":
      return `Read the timeline${range(a)}${Array.isArray(a.services) && a.services.length ? ` for ${list(a.services)}` : ""}`;
    case "search_logs":
      return `Searched ${a.service ?? "all"} logs${a.level ? ` (${a.level})` : ""}${a.contains ? ` for “${a.contains}”` : ""}${range(a)}`;
    case "get_alerts":
      return `Listed ${a.severity ? `${a.severity} ` : ""}alerts${a.service ? ` on ${a.service}` : ""}`;
    case "get_changes":
      return `Listed deploys and config changes${range(a)}`;
    case "get_metrics":
      return Array.isArray(a.series) && a.series.length
        ? `Read metrics: ${list((a.series as string[]).map((s) => chipLabel(s.startsWith("MET-") ? s : `MET-${s}`)))}`
        : "Listed available metrics";
    case "get_service_context":
      return `Looked up ${a.service} (dependencies, owners, DB budget)`;
    case "search_knowledge":
      return `Searched runbooks and past incidents for “${a.query}”`;
    case "get_evidence":
      return `Opened ${Array.isArray(a.ids) ? a.ids.length : 0} records: ${list(a.ids, 4)}`;
    case "update_investigation":
      return `Updated the brief (${Object.keys(a).length} fields)`;
    case "finalize":
      return "Finalized the brief";
    default:
      return tool;
  }
}

interface Turn {
  step: number;
  events: TraceStep[];
  calls: TraceStep[];
  reasoning: string;
  ms: number;
}

function toTurns(steps: TraceStep[]): Turn[] {
  const turns: Turn[] = [];
  for (const t of steps) {
    let turn = turns.at(-1);
    if (!turn || turn.step !== t.step) turns.push((turn = { step: t.step, events: [], calls: [], reasoning: "", ms: 0 }));
    turn.ms += t.ms;
    if (t.tool) {
      turn.calls.push(t);
      if (!turn.reasoning && t.thought) turn.reasoning = t.thought;
    } else if (t.label) turn.events.push(t);
    else if (t.thought && !turn.reasoning) turn.reasoning = t.thought;
  }
  return turns;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function Trace({ steps, running, progress }: { steps: TraceStep[]; running: boolean; progress: RunProgress | null }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [steps.length]);
  const now = useNow(running);
  const turns = toTurns(steps);
  const calls = steps.filter((t) => t.tool).length;

  const readout = progress ? runReadout(steps, progress, running, now) : null;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/40">
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Agent trace</h2>
        {running && !readout ? (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-sky-300">
            <span className="size-1.5 animate-pulse rounded-full bg-sky-300" />
            Connecting…
          </span>
        ) : running && readout ? (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-sky-300 tabular-nums">
            <span className="size-1.5 animate-pulse rounded-full bg-sky-300" />
            Turn {readout.turn}/{readout.maxTurns} · {readout.elapsedS}s
          </span>
        ) : (
          <span className="font-mono text-[11px] text-zinc-500">
            {turns.length} turns · {calls} tool calls
          </span>
        )}
      </header>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {turns.length === 0 && !running && <li className="text-xs text-zinc-500">Run an investigation to see what the agent does.</li>}
        {turns.map((turn) => (
          <TurnItem key={turn.step} turn={turn} />
        ))}
        {running && (
          <li className="flex items-center gap-2 px-1 text-xs text-sky-300">
            <span className="size-1.5 animate-pulse rounded-full bg-sky-300" /> thinking…
          </li>
        )}
        <div ref={end} />
      </ol>
    </div>
  );
}

function TurnItem({ turn }: { turn: Turn }) {
  return (
    <li className="rounded-md border border-zinc-800/80 bg-zinc-950/50 text-xs">
      <div className="flex items-center gap-2 border-b border-zinc-800/60 px-2.5 py-1.5">
        <span className="font-semibold text-zinc-300">Turn {turn.step}</span>
        {turn.calls.length > 1 && <span className="text-zinc-500">{turn.calls.length} calls in parallel</span>}
        {turn.ms > 0 && <span className="ml-auto font-mono text-[10px] text-zinc-600 tabular-nums">{turn.ms >= 1000 ? `${(turn.ms / 1000).toFixed(1)}s` : `${turn.ms}ms`}</span>}
      </div>
      <div className="space-y-1 px-2.5 py-2">
        {turn.events.map((e, i) => (
          <div key={i} className={`rounded border px-2 py-1 ${LABEL[e.label!].style}`}>
            <span className="font-semibold">{LABEL[e.label!].title}. </span>
            {e.thought.replace(/^Budget reminder:\s*/, "")}
          </div>
        ))}
        {turn.calls.map((t, i) => (
          <CallLine key={i} t={t} />
        ))}
        {turn.reasoning && (
          <details className="pt-0.5">
            <summary className="cursor-pointer text-[11px] text-zinc-600 select-none hover:text-zinc-400">reasoning</summary>
            <p className="mt-1 leading-relaxed whitespace-pre-wrap text-zinc-400">{turn.reasoning}</p>
          </details>
        )}
      </div>
    </li>
  );
}

function CallLine({ t }: { t: TraceStep }) {
  const args = (t.args ?? {}) as Args;
  const hasArgs = Object.keys(args).length > 0;
  const refused = /^refused|^rejected|^invalid input|^finalize rejected/.test(t.resultSummary ?? "");
  return (
    <details className="group">
      <summary className={`cursor-pointer list-none leading-relaxed select-none ${refused ? "text-amber-200/90" : "text-zinc-300"} hover:text-zinc-100`}>
        <span className="mr-1 text-zinc-600 group-open:rotate-90 inline-block transition-transform">›</span>
        {describeCall(t.tool!, args)}
        {t.resultSummary && (
          <span className="text-zinc-500">
            {" "}
            → <RichText text={t.resultSummary.length > 160 ? `${t.resultSummary.slice(0, 159)}…` : t.resultSummary} />
          </span>
        )}
      </summary>
      <div className="mt-1 ml-3 space-y-1">
        <div className="font-mono text-[10px] text-zinc-500">{t.tool}</div>
        {hasArgs && (
          <pre className="max-h-48 overflow-auto rounded bg-zinc-900 p-2 font-mono text-[10px] whitespace-pre-wrap text-zinc-400">{JSON.stringify(args, null, 2)}</pre>
        )}
      </div>
    </details>
  );
}
