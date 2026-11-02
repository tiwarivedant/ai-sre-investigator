import type { ConfigChangeRecord, DeployRecord, MetricSeries } from "@/lib/evidence/records";
import { round, valueAt, type ChangePoint } from "./changepoint";

export interface ChangeEvent {
  id: string;
  ts: string;
  service: string;
  kind: "deploy" | "rollback" | "config";
  summary: string;
  /** For staged deploys: when the rollout reached 100%. */
  fullRolloutTs?: string;
  /** Config-service / flag changes hot-reload and are absent from the deploy dashboard. */
  onDeployDashboard: boolean;
}

export type ChangeRelation = "before_onset_in_window" | "before_onset_outside_window" | "after_onset";

export interface SeriesEffect {
  seriesId: string;
  before: number;
  after: number;
  deltaPct: number;
}

export interface CorrelatedChange extends ChangeEvent {
  relation: ChangeRelation;
  /** Negative = before onset. Measured from fullRolloutTs when present. */
  minutesFromOnset: number;
  /** Change-points on the changed service's own metrics (does its own telemetry move?). */
  ownChangePoints: { seriesId: string; ts: string; lagMinutes: number }[];
  /** The changed service's own metrics that show no change-point. */
  ownQuietSeries: string[];
  /**
   * For changes made after onset (mitigations): did the anomalous series move?
   * Compares the bucket containing the change with the mean of the buckets
   * starting 5-15 minutes after it.
   */
  effects?: SeriesEffect[];
  /** Other changes within +/-5 minutes: their effects cannot be told apart from this one's. */
  concurrentChanges: string[];
}

export function toChangeEvents(
  deploys: DeployRecord[],
  configs: ConfigChangeRecord[],
  incidentDate: string,
): ChangeEvent[] {
  const events: ChangeEvent[] = [
    ...deploys.map((d) => ({
      id: d.id,
      ts: d.timestamp,
      service: d.service,
      kind: (d.type === "rollback" ? "rollback" : "deploy") as ChangeEvent["kind"],
      summary: `${d.version}: ${d.summary}`,
      fullRolloutTs: parseFullRollout(d.rollout, incidentDate),
      onDeployDashboard: true,
    })),
    ...configs.map((c) => ({
      id: c.id,
      ts: c.timestamp,
      service: c.service,
      kind: "config" as const,
      summary: c.change,
      onDeployDashboard: false,
    })),
  ];
  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** "canary 10% at 13:40, 100% at 13:47" -> ISO time of the 100% step. */
export function parseFullRollout(rollout: string | undefined, date: string): string | undefined {
  const m = rollout?.match(/100%\s+at\s+(\d{1,2}):(\d{2})/);
  return m ? `${date}T${m[1].padStart(2, "0")}:${m[2]}:00Z` : undefined;
}

export function correlateChanges(
  changes: ChangeEvent[],
  onset: string,
  changePoints: ChangePoint[],
  series: MetricSeries[],
  windowMinutes = 30,
): CorrelatedChange[] {
  return changes.map((c) => {
    const effectiveTs = c.fullRolloutTs ?? c.ts;
    const minutesFromOnset = minutesBetween(onset, effectiveTs);
    const relation: ChangeRelation =
      c.ts >= onset ? "after_onset" : minutesFromOnset >= -windowMinutes ? "before_onset_in_window" : "before_onset_outside_window";

    const own = series.filter((s) => s.service === c.service);
    const ownCps = changePoints.filter((cp) => cp.service === c.service);

    const result: CorrelatedChange = {
      ...c,
      relation,
      minutesFromOnset,
      ownChangePoints: ownCps.map((cp) => ({ seriesId: cp.seriesId, ts: cp.ts, lagMinutes: minutesBetween(onset, cp.ts) })),
      ownQuietSeries: own.filter((s) => !ownCps.some((cp) => cp.seriesId === s.id)).map((s) => s.id),
      concurrentChanges: changes
        .filter((o) => o.id !== c.id && Math.abs(minutesBetween(o.ts, c.ts)) <= 5)
        .map((o) => o.id),
    };
    if (relation === "after_onset") result.effects = measureEffects(c.ts, changePoints, series);
    return result;
  });
}

function measureEffects(ts: string, changePoints: ChangePoint[], series: MetricSeries[]): SeriesEffect[] {
  const from = addMinutes(ts, 5);
  const to = addMinutes(ts, 15);
  const effects: SeriesEffect[] = [];
  for (const cp of changePoints) {
    const s = series.find((x) => x.id === cp.seriesId);
    if (!s) continue;
    const before = valueAt(s.points, ts);
    const afterPts = s.points.filter((p) => p.ts >= from && p.ts <= to);
    if (before === undefined || afterPts.length === 0) continue;
    const after = afterPts.reduce((a, p) => a + p.value, 0) / afterPts.length;
    effects.push({
      seriesId: s.id,
      before,
      after: round(after),
      deltaPct: before === 0 ? 0 : round((100 * (after - before)) / before, 1),
    });
  }
  return effects;
}

/** b - a, in minutes. */
export function minutesBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

export function addMinutes(ts: string, m: number): string {
  return new Date(Date.parse(ts) + m * 60000).toISOString().replace(".000Z", "Z");
}
