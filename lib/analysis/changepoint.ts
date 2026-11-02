import type { MetricPoint, MetricSeries } from "@/lib/evidence/records";

export interface ChangePointOptions {
  /** Leading buckets used as the "normal" baseline. */
  baselineBuckets: number;
  /** Rule 1: value > ratio x baseline. */
  ratio: number;
  /**
   * Rule 2: relative rise >= minRelative AND >= minZ baseline standard deviations.
   * Needed for capped series (e.g. DB connections near max_connections) that can
   * never double but still shift sharply.
   */
  minRelative: number;
  minZ: number;
}

export const DEFAULT_CHANGEPOINT_OPTIONS: ChangePointOptions = {
  baselineBuckets: 4,
  ratio: 2,
  minRelative: 0.3,
  minZ: 3,
};

export interface ChangePoint {
  seriesId: string;
  series: string;
  service: string;
  ts: string; // first anomalous bucket
  baseline: number;
  value: number;
  rule: "ratio" | "deviation";
  /** Still anomalous in the next bucket (filters one-bucket blips). */
  sustained: boolean;
  peak: number;
  peakTs: string;
  /** First bucket after which the series stays back in its normal range. */
  recoveredAt?: string;
}

/**
 * Detect the first upward change-point in a series. Only increases are
 * detected: for error rates, latency, saturation and load, "up" is "bad".
 */
export function detectChangePoint(
  series: MetricSeries,
  opts: ChangePointOptions = DEFAULT_CHANGEPOINT_OPTIONS,
): ChangePoint | null {
  const pts = series.points;
  if (pts.length <= opts.baselineBuckets) return null;

  const base = pts.slice(0, opts.baselineBuckets).map((p) => p.value);
  const baseline = mean(base);
  // Floor sigma so perfectly flat baselines don't make every wiggle infinite-z.
  const sigma = Math.max(stddev(base), Math.abs(baseline) * 0.02, 1e-9);

  const anomalous = (v: number): "ratio" | "deviation" | null => {
    if (baseline > 0 && v > opts.ratio * baseline) return "ratio";
    const rise = v - baseline;
    const rel = baseline !== 0 ? rise / Math.abs(baseline) : rise > 0 ? Infinity : 0;
    if (rel >= opts.minRelative && rise / sigma >= opts.minZ) return "deviation";
    return null;
  };

  for (let i = opts.baselineBuckets; i < pts.length; i++) {
    const rule = anomalous(pts[i].value);
    if (!rule) continue;

    const after = pts.slice(i);
    const peakPoint = after.reduce((a, b) => (b.value > a.value ? b : a));
    const sustained = i + 1 >= pts.length || anomalous(pts[i + 1].value) !== null;

    let recoveredAt: string | undefined;
    for (let j = i + 1; j < pts.length; j++) {
      if (pts.slice(j).every((p) => anomalous(p.value) === null)) {
        recoveredAt = pts[j].ts;
        break;
      }
    }

    return {
      seriesId: series.id,
      series: series.name,
      service: series.service,
      ts: pts[i].ts,
      baseline: round(baseline),
      value: pts[i].value,
      rule,
      sustained,
      peak: peakPoint.value,
      peakTs: peakPoint.ts,
      recoveredAt,
    };
  }
  return null;
}

export function detectChangePoints(
  all: MetricSeries[],
  opts: ChangePointOptions = DEFAULT_CHANGEPOINT_OPTIONS,
): ChangePoint[] {
  return all
    .map((s) => detectChangePoint(s, opts))
    .filter((c): c is ChangePoint => c !== null)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.series.localeCompare(b.series));
}

/** Incident onset: the earliest sustained change-point. */
export function detectOnset(changePoints: ChangePoint[]): string | undefined {
  return changePoints.filter((c) => c.sustained).map((c) => c.ts).sort()[0];
}

export interface Saturation {
  seriesId: string;
  limitSeriesId: string;
  peakUtilizationPct: number;
  peakTs: string;
  firstOver80Ts?: string;
}

/**
 * Pair usage series with their limit series by naming convention
 * (`orders_db.active_connections` with `orders_db.max_connections`) and report
 * how close to the ceiling they ran. Saturation is often the real story when
 * a resource is capped.
 */
export function detectSaturation(all: MetricSeries[]): Saturation[] {
  const out: Saturation[] = [];
  for (const limit of all) {
    const m = limit.name.match(/^(.+)\.max_(.+)$/);
    if (!m) continue;
    const [, prefix, quantity] = m;
    const usage = all.find((s) => s !== limit && s.name.startsWith(`${prefix}.`) && s.name.endsWith(quantity));
    if (!usage) continue;
    let peak = { pct: 0, ts: "" };
    let firstOver80: string | undefined;
    usage.points.forEach((p, i) => {
      const cap = limit.points[i]?.value;
      if (!cap) return;
      const pct = (100 * p.value) / cap;
      if (pct > peak.pct) peak = { pct, ts: p.ts };
      if (pct >= 80 && !firstOver80) firstOver80 = p.ts;
    });
    out.push({
      seriesId: usage.id,
      limitSeriesId: limit.id,
      peakUtilizationPct: round(peak.pct),
      peakTs: peak.ts,
      firstOver80Ts: firstOver80,
    });
  }
  return out;
}

export function valueAt(points: MetricPoint[], ts: string): number | undefined {
  // Value of the bucket containing ts (last bucket starting at or before ts).
  let v: number | undefined;
  for (const p of points) if (p.ts <= ts) v = p.value;
  return v;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function round(x: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
