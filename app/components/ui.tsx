"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Hypothesis, InvestigationState, Risk } from "@/lib/types";

// Small shared pieces: evidence chips (clickable everywhere), badges, bars.

export const EvidenceContext = createContext<(id: string) => void>(() => {});

const KIND_STYLE: Record<string, string> = {
  ALR: "text-rose-300 border-rose-500/30 bg-rose-500/10",
  LOG: "text-sky-300 border-sky-500/30 bg-sky-500/10",
  DEP: "text-violet-300 border-violet-500/30 bg-violet-500/10",
  CFG: "text-amber-300 border-amber-500/30 bg-amber-500/10",
  MET: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
  RB: "text-zinc-300 border-zinc-500/40 bg-zinc-500/10",
  INC: "text-zinc-300 border-zinc-500/40 bg-zinc-500/10",
  CHAT: "text-teal-300 border-teal-500/30 bg-teal-500/10",
  CUST: "text-pink-300 border-pink-500/30 bg-pink-500/10",
  USER: "text-yellow-200 border-yellow-400/50 bg-yellow-400/15",
};

/** "MET-orders_db.active_connections" -> "orders-db active connections"; other IDs unchanged. */
export function chipLabel(id: string): string {
  if (!id.startsWith("MET-")) return id;
  const [svc, metric = ""] = id.slice(4).split(".");
  const m = metric
    .replace(/_pct$/, " %")
    .replace(/_ms$/, " (ms)")
    .replace(/_per_min$/, "/min")
    .replace(/_/g, " ");
  return `${svc.replace(/_/g, "-")} ${m}`.trim();
}

/**
 * Clickable evidence reference. "full" is the colour-coded chip for evidence
 * lists; "inline" is a small muted chip for citations inside prose, so the
 * sentence stays readable.
 */
export function EvidenceChip({ id, tone, variant = "full" }: { id: string; tone?: "support" | "contra"; variant?: "full" | "inline" }) {
  const open = useContext(EvidenceContext);
  const label = chipLabel(id);
  const title = label === id ? `Open ${id}` : `${id} (open)`;
  if (variant === "inline") {
    return (
      <button
        type="button"
        onClick={() => open(id)}
        title={title}
        className="mx-px inline-block max-w-full truncate rounded border border-zinc-700/70 bg-zinc-800/50 px-1 align-baseline font-mono text-[10px] leading-[14px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
      >
        {label}
      </button>
    );
  }
  const prefix = id.split("-")[0];
  const toneStyle =
    tone === "contra" ? "text-red-300 border-red-500/40 bg-red-500/10" : (KIND_STYLE[prefix] ?? "text-zinc-300 border-zinc-600 bg-zinc-800");
  return (
    <button
      type="button"
      onClick={() => open(id)}
      title={title}
      className={`inline-block max-w-full truncate rounded border px-1.5 py-px align-baseline font-mono text-[11px] leading-4 hover:brightness-125 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 ${toneStyle}`}
    >
      {label}
    </button>
  );
}

// Same ID shapes the grounding guard recognises, plus past incidents.
const ID_RE = /\b(?:ALR|LOG|DEP|CFG|CHAT|CUST|USER)-\d+\b|\bINC-\d+\b|\bRB-[a-z0-9-]+\b|\bMET-[a-z0-9_]+\.[a-z0-9_]+\b/g;

/** Prose with evidence IDs turned into small, muted, clickable chips. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(ID_RE)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(<EvidenceChip key={`${m.index}-${m[0]}`} id={m[0]} variant="inline" />);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <span className={className}>{parts}</span>;
}

export function Chips({ ids, tone, empty = "none" }: { ids: string[]; tone?: "support" | "contra"; empty?: string }) {
  if (!ids.length) return <span className="text-xs text-zinc-600">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <EvidenceChip key={id} id={id} tone={tone} />
      ))}
    </span>
  );
}

const RISK_STYLE: Record<Risk, string> = {
  low: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
  medium: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  high: "text-red-300 bg-red-500/10 border-red-500/40",
};

export function RiskBadge({ risk, reason }: { risk: Risk; reason?: string }) {
  return (
    <span title={reason} className={`inline-flex shrink-0 rounded border px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase ${RISK_STYLE[risk]}`}>
      {risk} risk
    </span>
  );
}

const STATUS_STYLE: Record<Hypothesis["status"], string> = {
  confirmed: "text-emerald-200 bg-emerald-500/15 border-emerald-400/40",
  active: "text-sky-200 bg-sky-500/10 border-sky-400/30",
  rejected: "text-zinc-400 bg-zinc-700/30 border-zinc-600",
};

export function HypothesisStatus({ status }: { status: Hypothesis["status"] }) {
  return <span className={`rounded border px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase ${STATUS_STYLE[status]}`}>{status}</span>;
}

const RUN_STYLE: Record<InvestigationState["status"], string> = {
  running: "text-sky-200 bg-sky-500/10 border-sky-400/30",
  complete: "text-emerald-200 bg-emerald-500/10 border-emerald-400/30",
  partial: "text-amber-200 bg-amber-500/10 border-amber-400/30",
  error: "text-red-200 bg-red-500/10 border-red-400/40",
};

const RUN_LABEL: Record<InvestigationState["status"], string> = {
  running: "Agent running",
  complete: "",
  partial: "Partial brief",
  error: "Agent error",
};

/**
 * The agent run's status (not the incident's). A finished run is the normal case and shows
 * nothing, so it isn't read as the incident being complete; the rest need attention.
 */
export function RunStatus({ status, reason }: { status: InvestigationState["status"]; reason?: string }) {
  if (status === "complete") return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-medium ${RUN_STYLE[status]} ${reason ? "cursor-help" : ""}`}
      title={reason}
    >
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-sky-300" />}
      {RUN_LABEL[status]}
    </span>
  );
}

export function ConfidenceBar({ value, label, showValue = true }: { value: number; label?: string; showValue?: boolean }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.75 ? "bg-emerald-400" : value >= 0.5 ? "bg-amber-400" : "bg-zinc-500";
  return (
    <div className="flex items-center gap-2" title={label}>
      <div className="h-1.5 w-full min-w-16 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full transition-[width] duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      {showValue && <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-zinc-300">{pct}%</span>}
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2">
        <h2 className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">{title}</h2>
        {aside}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** Plain-language confidence for the verdict: the number alone invites false precision. */
export function confidenceWord(value: number, status?: "active" | "rejected" | "confirmed"): string {
  if (status === "confirmed") return "Confirmed";
  if (value >= 0.8) return "Likely";
  if (value >= 0.6) return "Probable";
  if (value >= 0.4) return "Possible";
  return "Uncertain";
}

const INCIDENT_STYLE: Record<NonNullable<InvestigationState["incidentStatus"]>, { label: string; style: string }> = {
  investigating: { label: "Investigating", style: "text-sky-200 bg-sky-500/10 border-sky-400/40" },
  identified: { label: "Identified", style: "text-violet-200 bg-violet-500/10 border-violet-400/40" },
  mitigated: { label: "Mitigated", style: "text-amber-200 bg-amber-500/10 border-amber-400/40" },
  resolved: { label: "Resolved", style: "text-emerald-200 bg-emerald-500/10 border-emerald-400/40" },
  "insufficient-evidence": { label: "Insufficient evidence", style: "text-orange-200 bg-orange-500/10 border-orange-400/40" },
};

/** Incident lifecycle badge (distinct from the run status). */
export function IncidentStatusBadge({ status }: { status?: InvestigationState["incidentStatus"] }) {
  const s = INCIDENT_STYLE[status ?? "investigating"];
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${s.style}`}>{s.label}</span>;
}

/** "45s", "12m", "3h 05m", "2d 4h" */
export function formatElapsed(fromIso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
