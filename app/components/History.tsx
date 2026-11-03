"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InvestigationSummary } from "@/lib/store";
import { confidenceWord, formatElapsed, IncidentStatusBadge, RunStatus } from "./ui";

interface Lists {
  recent: InvestigationSummary[];
  samples: InvestigationSummary[];
}

export function useInvestigationList() {
  const [lists, setLists] = useState<Lists | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    fetch("/api/investigations", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: Lists) => {
        setLists(d);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  return { lists, failed, refresh };
}

function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function InvestigationRow({ inv, active, onOpen }: { inv: InvestigationSummary; active: boolean; onOpen: (id: string) => void }) {
  const top = inv.topHypothesis;
  return (
    <button
      type="button"
      onClick={() => onOpen(inv.id)}
      aria-current={active || undefined}
      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${active ? "border-zinc-500 bg-zinc-800/70" : "border-transparent hover:border-zinc-700 hover:bg-zinc-800/40"}`}
    >
      {inv.label && <p className="text-sm font-medium text-zinc-100">{inv.label}</p>}
      <p className={inv.label ? "line-clamp-2 text-xs text-zinc-400" : "line-clamp-2 text-sm text-zinc-200"}>{inv.incidentInput}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
        <IncidentStatusBadge status={inv.incidentStatus} />
        <RunStatus status={inv.status} reason={inv.statusReason} />
        {inv.open && !inv.sample && <span title={`Opened ${new Date(inv.createdAt).toLocaleString()}`}>open {formatElapsed(inv.createdAt)}</span>}
        {inv.sample && <span className="rounded border border-sky-400/40 bg-sky-500/10 px-1.5 py-px font-semibold tracking-wide text-sky-200 uppercase">Sample</span>}
        {inv.followUps > 0 && <span>{inv.followUps} follow-up{inv.followUps > 1 ? "s" : ""}</span>}
        {!inv.sample && (
          <span className="ml-auto whitespace-nowrap" title={`${inv.provider} · ${inv.model} · ${new Date(inv.updatedAt).toLocaleString()}`}>
            {inv.provider} · {ago(inv.updatedAt)}
          </span>
        )}
      </div>
      <p className="mt-1 truncate text-xs text-zinc-400" title={top?.statement}>
        {top ? (
          <>
            <span className="text-zinc-300">
              {confidenceWord(top.confidence, top.status as "active" | "confirmed")} {Math.round(top.confidence * 100)}%
            </span>{" "}
            · {top.statement}
          </>
        ) : inv.briefSource === "pre-analysis" ? (
          <span className="italic">Pre-analysis only (agent did not finish)</span>
        ) : (
          <span className="italic">No hypothesis yet</span>
        )}
      </p>
    </button>
  );
}

/** "2 open · 3 resolved" for the recent (non-sample) investigations. */
export function openResolvedCount(recent: InvestigationSummary[]): string {
  const open = recent.filter((r) => r.open).length;
  return `${open} open · ${recent.length - open} resolved`;
}

/** Header dropdown: recent investigations and samples. */
export function HistoryMenu({ activeId, onOpen }: { activeId?: string; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const { lists, failed, refresh } = useInvestigationList();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    refresh(); // new runs appear without a page reload
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open, refresh]);

  const pick = (id: string) => {
    setOpen(false);
    onOpen(id);
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
      >
        Investigations ▾
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1.5 w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl">
          <div className="max-h-[70vh] overflow-y-auto p-2">
            {failed && <p className="px-2 py-3 text-xs text-red-300">Couldn&apos;t load investigations.</p>}
            {!lists && !failed && <p className="px-2 py-3 text-xs text-zinc-500">Loading…</p>}
            {lists && (
              <>
                <h3 className="flex items-baseline justify-between px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
                  Recent
                  {lists.recent.length > 0 && <span className="font-normal tracking-normal normal-case" data-testid="open-count">{openResolvedCount(lists.recent)}</span>}
                </h3>
                {lists.recent.length === 0 && <p className="px-2 pb-2 text-xs text-zinc-500">None yet. Runs you start are saved here.</p>}
                <div className="space-y-0.5">
                  {lists.recent.map((inv) => (
                    <InvestigationRow key={inv.id} inv={inv} active={inv.id === activeId} onOpen={pick} />
                  ))}
                </div>
                {lists.samples.length > 0 && (
                  <>
                    <h3 className="mt-2 border-t border-zinc-800 px-2 pt-2.5 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
                      Samples <span className="font-normal tracking-normal normal-case">· read-only, no API key needed</span>
                    </h3>
                    <div className="space-y-0.5">
                      {lists.samples.map((inv) => (
                        <InvestigationRow key={inv.id} inv={inv} active={inv.id === activeId} onOpen={pick} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** For the empty state: give someone without an API key something to open. */
export function SampleList({ onOpen }: { onOpen: (id: string) => void }) {
  const { lists, refresh } = useInvestigationList();
  useEffect(refresh, [refresh]);
  if (!lists?.samples.length) return null;
  return (
    <div className="mx-auto mt-6 max-w-xl text-left">
      <h3 className="mb-1 px-3 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Or open a sample investigation</h3>
      <div className="space-y-1">
        {lists.samples.map((inv) => (
          <InvestigationRow key={inv.id} inv={inv} active={false} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}
