import type { EvidenceStore } from "@/lib/evidence/loader";
import type { EvidenceKind } from "@/lib/types";
import type { ChangePoint } from "./changepoint";

export interface TimelineEvent {
  ts: string;
  evidenceId: string;
  kind: EvidenceKind | "changepoint";
  service?: string;
  title: string;
}

export interface TimelineFilter {
  from?: string;
  to?: string;
  services?: string[];
  kinds?: TimelineEvent["kind"][];
}

/**
 * Unified, sorted event stream. Logs are excluded by default (they have their
 * own search tool and would drown everything else); metric change-points are
 * included as synthetic events that cite their MET- series.
 */
export function buildTimeline(store: EvidenceStore, changePoints: ChangePoint[], includeLogs = false): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const e of store.list()) {
    if (!e.timestamp || e.kind === "metric") continue;
    if (e.kind === "log" && !includeLogs) continue;
    events.push({ ts: e.timestamp, evidenceId: e.id, kind: e.kind, service: e.service, title: e.title });
  }
  for (const cp of changePoints) {
    events.push({
      ts: cp.ts,
      evidenceId: cp.seriesId,
      kind: "changepoint",
      service: cp.service,
      title: `${cp.series} rose ${cp.baseline} -> ${cp.value} (peak ${cp.peak})${cp.recoveredAt ? `, recovered ${cp.recoveredAt.slice(11, 16)}` : ""}`,
    });
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts) || a.evidenceId.localeCompare(b.evidenceId));
}

export function filterTimeline(events: TimelineEvent[], f: TimelineFilter): TimelineEvent[] {
  return events.filter(
    (e) =>
      (!f.from || e.ts >= f.from) &&
      (!f.to || e.ts <= f.to) &&
      (!f.services?.length || (e.service !== undefined && f.services.includes(e.service))) &&
      (!f.kinds?.length || f.kinds.includes(e.kind)),
  );
}
