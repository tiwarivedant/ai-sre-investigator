import type { EvidenceStore } from "@/lib/evidence/loader";
import type { PreAnalysis } from "@/lib/analysis/preAnalysis";
import type { CitedNote, InvestigationState, TimelineEntry } from "@/lib/types";

const hhmm = (ts: string) => ts.slice(11, 16);

/**
 * When the agent ends without writing any brief (rate limits, timeouts,
 * provider errors), responders still get the deterministic findings instead
 * of an empty page. Strictly facts code computed: no hypotheses, confidence,
 * or recommended actions, because those are judgments only the agent makes.
 */
export function preAnalysisBrief(
  pa: PreAnalysis,
  store: EvidenceStore,
  reason: string,
): Pick<InvestigationState, "summary" | "impact" | "timeline" | "keySignals" | "noise" | "openQuestions"> {
  const onset = pa.onset;
  const sustained = pa.changePoints.filter((c) => c.sustained);
  const firstMovers = onset ? sustained.filter((c) => c.ts === onset) : [];
  const inWindow = pa.changes.filter((c) => c.relation === "before_onset_in_window");
  const saturated = pa.saturation.filter((s) => s.peakUtilizationPct >= 80);
  const critical = store.alerts.filter((a) => a.severity === "critical");

  const summary = [
    `The agent did not finish (${reason}), so this is the automated pre-analysis only: no root cause has been judged.`,
    onset
      ? `Metrics first moved at ${hhmm(onset)} UTC (${firstMovers.map((c) => c.seriesId).join(", ")}).`
      : "No sustained metric change-point was detected.",
    inWindow.length
      ? `${inWindow.length} change${inWindow.length > 1 ? "s" : ""} landed in the 30 minutes before onset: ${inWindow.map((c) => `${c.id} (${c.service})`).join(", ")}.`
      : "No deploy or config change landed in the 30 minutes before onset.",
    ...saturated.map((s) => `${s.seriesId} peaked at ${s.peakUtilizationPct}% of its limit (${s.limitSeriesId}).`),
  ].join(" ");

  const impact = critical.length
    ? `Critical alerts firing: ${critical.map((a) => `${a.id} (${a.service})`).join(", ")}.`
    : "No critical alerts.";

  const timeline: TimelineEntry[] = [
    ...inWindow.map((c) => ({ ts: c.ts, evidenceId: c.id, note: `${c.kind} ${c.service}: ${c.summary}` })),
    ...firstMovers.map((c) => ({ ts: c.ts, evidenceId: c.seriesId, note: `${c.series} rose from ${c.baseline} to ${c.value}` })),
    ...critical.map((a) => ({ ts: a.timestamp, evidenceId: a.id, note: a.title })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));

  const keySignals: CitedNote[] = [
    ...inWindow.map((c) => ({
      evidenceId: c.id,
      why: `${c.kind} ${Math.abs(c.minutesFromOnset)} min before onset${c.onDeployDashboard ? "" : " (not on the deploy dashboard)"}`,
    })),
    ...saturated.map((s) => ({ evidenceId: s.seriesId, why: `peaked at ${s.peakUtilizationPct}% of its limit at ${hhmm(s.peakTs)}` })),
    ...firstMovers.map((c) => ({ evidenceId: c.seriesId, why: `first metric to move, at ${hhmm(c.ts)}` })),
  ];

  const noise: CitedNote[] = pa.alerts.filter((a) => a.likelyNoise).map((a) => ({ evidenceId: a.id, why: `heuristic flags: ${a.flags.join(", ")}` }));

  const openQuestions = [
    ...inWindow.map((c) => {
      const oncall = store.catalog.services[c.service]?.oncall;
      return `Did ${c.id} (${c.service}: ${c.summary}) contribute to the onset at ${onset ? hhmm(onset) : "?"}?${oncall ? ` Ask ${oncall}.` : ""}`;
    }),
    "Re-run the investigation to get the agent's analysis.",
  ];

  return { summary, impact, timeline, keySignals, noise, openQuestions };
}
