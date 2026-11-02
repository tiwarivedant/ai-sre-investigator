import type { EvidenceStore } from "@/lib/evidence/loader";
import type { PreAnalysis } from "./preAnalysis";
import { downstream } from "./topology";

export interface ChartSeries {
  id: string; // MET-...
  label: string;
  unit: string;
  points: { ts: string; value: number }[];
  /** Hard ceiling (e.g. max_connections), drawn as a reference line. */
  limit?: number;
}

export interface ChartMarker {
  id: string; // evidence to open on click
  ts: string;
  label: string;
  kind: "deploy" | "config" | "onset";
}

export interface ChartData {
  series: ChartSeries[];
  markers: ChartMarker[];
  onset?: string;
}

/**
 * What to plot, chosen from the pre-analysis rather than hard-coded: the
 * customer-facing error rate (earliest sustained error-rate change, preferring
 * the service with the most downstream dependencies), the most saturated
 * resource with its limit, and markers for the changes in the window before
 * onset plus the onset itself.
 */
export function chartData(pa: PreAnalysis, store: EvidenceStore): ChartData {
  const series: ChartSeries[] = [];
  const bySeries = (id: string) => store.metrics.find((m) => m.id === id);

  const errorCp = pa.changePoints
    .filter((c) => c.sustained && /error_rate/.test(c.series))
    .sort((a, b) => a.ts.localeCompare(b.ts) || downstream(store.catalog, b.service).size - downstream(store.catalog, a.service).size)[0];
  const err = errorCp && bySeries(errorCp.seriesId);
  if (err) series.push({ id: err.id, label: `${err.service.replace(/-service$/, "")} error rate`, unit: "%", points: err.points });

  const sat = [...pa.saturation].filter((s) => s.peakUtilizationPct >= 80).sort((a, b) => b.peakUtilizationPct - a.peakUtilizationPct)[0];
  const usage = sat && bySeries(sat.seriesId);
  if (usage) {
    const limit = bySeries(sat.limitSeriesId)?.points.at(-1)?.value;
    const quantity = usage.name.split(".")[1]?.replace(/_/g, " ") ?? usage.name;
    series.push({ id: usage.id, label: `${usage.service} ${quantity}`, unit: "", points: usage.points, limit });
  }

  const markers: ChartMarker[] = pa.changes
    .filter((c) => c.relation === "before_onset_in_window")
    .map((c) => ({ id: c.id, ts: c.ts, label: c.id, kind: c.kind === "config" ? ("config" as const) : ("deploy" as const) }));
  if (pa.onset) {
    const firstMover = pa.changePoints.find((c) => c.sustained && c.ts === pa.onset && c.seriesId === err?.id) ?? pa.changePoints.find((c) => c.ts === pa.onset);
    markers.push({ id: firstMover?.seriesId ?? err?.id ?? "", ts: pa.onset, label: `onset ${pa.onset.slice(11, 16)}`, kind: "onset" });
  }
  return { series, markers: markers.sort((a, b) => a.ts.localeCompare(b.ts)), onset: pa.onset };
}
