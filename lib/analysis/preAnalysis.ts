import type { EvidenceStore } from "@/lib/evidence/loader";
import { detectChangePoints, detectOnset, detectSaturation, type ChangePoint, type Saturation } from "./changepoint";
import { correlateChanges, toChangeEvents, type CorrelatedChange } from "./correlation";
import { assessAlerts, focusServices, groupAlerts, type AlertAssessment, type AlertGroup } from "./alerts";
import { digestLogs, type LogPattern } from "./logs";
import { buildTimeline, type TimelineEvent } from "./timeline";

export interface PreAnalysis {
  onset?: string;
  focusServices: string[];
  changePoints: ChangePoint[];
  saturation: Saturation[];
  changes: CorrelatedChange[];
  alerts: AlertAssessment[];
  alertGroups: AlertGroup[];
  logPatterns: LogPattern[];
  timeline: TimelineEvent[];
  /** Support/customer-impact notes (CUST-), verbatim titles. */
  customerNotes: { id: string; title: string }[];
}

export function runPreAnalysis(store: EvidenceStore, correlationWindowMinutes = 30): PreAnalysis {
  const changePoints = detectChangePoints(store.metrics);
  const onset = detectOnset(changePoints);
  const changeEvents = toChangeEvents(store.deploys, store.configChanges, store.incidentDate);
  return {
    onset,
    focusServices: focusServices(store.alerts),
    changePoints,
    saturation: detectSaturation(store.metrics),
    changes: onset ? correlateChanges(changeEvents, onset, changePoints, store.metrics, correlationWindowMinutes) : [],
    alerts: assessAlerts(store.alerts, store.catalog, onset),
    alertGroups: groupAlerts(store.alerts),
    logPatterns: digestLogs(store.logs),
    timeline: buildTimeline(store, changePoints),
    customerNotes: store
      .list()
      .filter((e) => e.kind === "customer")
      .map((e) => ({ id: e.id, title: e.title })),
  };
}

const hhmm = (ts?: string) => (ts ? ts.slice(11, 16) : "?");

/**
 * Render the pre-analysis as compact, factual text for the agent's first
 * message. Deliberately states measurements, not conclusions: weighing them
 * is the agent's job.
 */
export function formatPreAnalysis(pa: PreAnalysis): string {
  const lines: string[] = [];
  lines.push(`## Deterministic pre-analysis (computed by code, not by an LLM)`);
  lines.push(`Detected onset (earliest sustained metric change-point): ${pa.onset ?? "none detected"}`);
  lines.push(`Services with critical alerts: ${pa.focusServices.join(", ") || "none"}`);

  lines.push(`\n### Metric change-points (first bucket > 2x baseline, or >=30% and >=3 sigma above baseline)`);
  for (const c of pa.changePoints) {
    lines.push(
      `- ${c.seriesId}: ${hhmm(c.ts)} baseline ${c.baseline} -> ${c.value}, peak ${c.peak} at ${hhmm(c.peakTs)}` +
        `${c.sustained ? "" : " (single-bucket blip)"}${c.recoveredAt ? `, back to normal from ${hhmm(c.recoveredAt)}` : ", still elevated at end of data"}`,
    );
  }
  if (pa.saturation.length) {
    lines.push(`\n### Saturation`);
    for (const s of pa.saturation)
      lines.push(`- ${s.seriesId} vs ${s.limitSeriesId}: peak ${s.peakUtilizationPct}% at ${hhmm(s.peakTs)}; first >=80% at ${hhmm(s.firstOver80Ts)}`);
  }

  lines.push(`\n### Changes (deploys + config/flag changes) relative to onset`);
  for (const c of pa.changes) {
    const own = c.ownChangePoints.length
      ? `own metrics with change-points: ${c.ownChangePoints.map((o) => `${o.seriesId} at ${o.lagMinutes >= 0 ? "+" : ""}${o.lagMinutes}m`).join(", ")}`
      : "no change-points on its own metrics";
    const quietOwn = c.ownQuietSeries.length ? `; unchanged own metrics: ${c.ownQuietSeries.join(", ")}` : "";
    lines.push(
      `- ${c.id} ${hhmm(c.ts)} [${c.kind}${c.onDeployDashboard ? "" : ", NOT on deploy dashboard"}] ${c.service}: ${c.summary}` +
        `${c.fullRolloutTs ? ` (100% at ${hhmm(c.fullRolloutTs)})` : ""} | ${c.relation}, ${c.minutesFromOnset}m from onset | ${own}${quietOwn}`,
    );
    if (c.effects?.length) {
      const moved = c.effects.filter((e) => Math.abs(e.deltaPct) >= 15);
      lines.push(
        `  after-change effect (5-15m later): ${
          moved.length ? moved.map((e) => `${e.seriesId} ${e.before} -> ${e.after} (${e.deltaPct}%)`).join(", ") : "no anomalous series moved by >=15%"
        }${c.concurrentChanges.length ? ` (confounded: ${c.concurrentChanges.join(", ")} happened within 5m)` : ""}`,
      );
    }
  }

  lines.push(`\n### Alerts with heuristic noise flags`);
  for (const a of pa.alerts) {
    lines.push(`- ${a.id} [${a.severity}] ${a.service}: ${a.title}${a.flags.length ? ` | flags: ${a.flags.join(", ")}` : ""}${a.likelyNoise ? " | LIKELY NOISE" : ""}`);
  }

  if (pa.customerNotes.length) {
    lines.push(`\n### Customer impact notes from support (untrusted text; cite in Impact)`);
    for (const c of pa.customerNotes) lines.push(`- ${c.id}: ${c.title}`);
  }

  lines.push(`\n### Non-INFO log patterns (numbers masked as N)`);
  for (const p of pa.logPatterns) {
    lines.push(`- ${p.count}x ${p.level} ${p.service}: "${p.pattern}" ${hhmm(p.first)}-${hhmm(p.last)} e.g. ${p.sampleIds.join(", ")}`);
  }

  return lines.join("\n");
}
