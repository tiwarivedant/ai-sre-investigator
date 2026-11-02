"use client";

import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChartData, ChartMarker } from "@/lib/analysis/chartData";
import { EvidenceChip, EvidenceContext } from "./ui";

// Two small multiples on one time axis (never a dual-axis chart): different
// units get their own panel. Series colours: categorical slots 1-2, dark steps,
// validated against the panel surface (#111113). Text stays in text tokens.
const SERIES_COLORS = ["#3987e5", "#d95926"];
const M = { left: 44, right: 14, top: 8, bottom: 22 };
const PANEL_H = 70; // plot height per panel
const PANEL_GAP = 40; // room for the x-gap and the next panel's title
const ROW_H = 22; // marker label row

const hhmm = (ts: string) => ts.slice(11, 16);
const fmt = (v: number, unit: string) => `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`;

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? v;
}

export function useChartData() {
  const [data, setData] = useState<ChartData | null>(null);
  useEffect(() => {
    fetch("/api/chart")
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {});
  }, []);
  return data;
}

export function IncidentChart({ data }: { data: ChartData }) {
  const open = useContext(EvidenceContext);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const times = data.series[0]?.points.map((p) => p.ts) ?? [];
  if (!times.length) return null;
  const t0 = Date.parse(times[0]);
  const t1 = Date.parse(times[times.length - 1]);
  const plotW = width - M.left - M.right;
  const x = (ts: string) => M.left + ((Date.parse(ts) - t0) / (t1 - t0 || 1)) * plotW;

  // Marker labels: stagger into rows so close events (13:40, 13:52, 13:55) don't collide.
  const rowsRight: number[] = [];
  const placed = data.markers
    .filter((m) => Date.parse(m.ts) >= t0 && Date.parse(m.ts) <= t1)
    .map((m) => {
      const w = m.label.length * 6.6 + 16;
      const cx = x(m.ts);
      const left = Math.min(Math.max(cx - w / 2, 0), width - w);
      let row = rowsRight.findIndex((r) => left > r + 4);
      if (row < 0) row = rowsRight.push(0) - 1;
      rowsRight[row] = left + w;
      return { ...m, cx, left, row };
    });
  const labelsH = Math.max(1, rowsRight.length) * ROW_H;
  const panelTop = (i: number) => labelsH + M.top + 14 + i * (PANEL_H + PANEL_GAP);
  const height = panelTop(data.series.length - 1) + PANEL_H + M.bottom;
  const plotsTop = panelTop(0);
  const plotsBottom = panelTop(data.series.length - 1) + PANEL_H;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    let best = 0;
    times.forEach((t, i) => Math.abs(x(t) - px) < Math.abs(x(times[best]) - px) && (best = i));
    setHover(best);
  };

  const xTicks = times.filter((_, i) => i % 3 === 0);

  return (
    <figure className="mb-4">
      <div ref={wrap} className="relative w-full" onMouseLeave={() => setHover(null)}>
        {/* Marker labels: clickable evidence */}
        {placed.map((m) => (
          <div key={m.id + m.ts} className="absolute" style={{ left: m.left, top: m.row * ROW_H }}>
            {m.kind === "onset" ? (
              <button
                type="button"
                onClick={() => open(m.id)}
                title={`Detected onset: first sustained change, ${m.id} (open)`}
                className="rounded border border-zinc-500 bg-zinc-800 px-1.5 py-px font-mono text-[11px] leading-4 text-zinc-100 hover:border-zinc-300"
              >
                {m.label}
              </button>
            ) : (
              <EvidenceChip id={m.id} />
            )}
          </div>
        ))}

        <svg width={width} height={height} role="img" aria-label={`${data.series.map((s) => s.label).join(" and ")} over time, with change and onset markers`} className="block">
          {data.series.map((s, i) => {
            const top = panelTop(i);
            const max = niceMax(Math.max(...s.points.map((p) => p.value), s.limit ?? 0) * 1.05);
            const y = (v: number) => top + PANEL_H - (v / max) * PANEL_H;
            const path = s.points.map((p, j) => `${j ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
            const peak = s.points.reduce((a, b) => (b.value > a.value ? b : a));
            return (
              <g key={s.id}>
                <text x={M.left} y={top - 8} className="fill-zinc-300 text-[11px] font-medium">
                  {s.label}
                  {s.unit === "%" ? " (%)" : ""}
                </text>
                {[0, max / 2, max].map((v) => (
                  <g key={v}>
                    <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} stroke="#27272a" strokeWidth={1} />
                    <text x={M.left - 6} y={y(v) + 3} textAnchor="end" className="fill-zinc-500 font-mono text-[10px]">
                      {fmt(v, "")}
                    </text>
                  </g>
                ))}
                {s.limit !== undefined && (
                  <g>
                    <line x1={M.left} x2={width - M.right} y1={y(s.limit)} y2={y(s.limit)} stroke="#71717a" strokeWidth={1} strokeDasharray="4 3" />
                    <text x={width - M.right} y={y(s.limit) - 4} textAnchor="end" className="fill-zinc-400 text-[10px]">
                      max {s.limit}
                    </text>
                  </g>
                )}
                <path d={path} fill="none" stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {/* One selective direct label: the peak */}
                <circle cx={x(peak.ts)} cy={y(peak.value)} r={3} fill={SERIES_COLORS[i % SERIES_COLORS.length]} stroke="#111113" strokeWidth={2} />
                <text x={x(peak.ts) + 6} y={y(peak.value) - 6} className="fill-zinc-300 font-mono text-[10px]">
                  peak {fmt(peak.value, s.unit)}
                </text>
              </g>
            );
          })}

          {/* Event markers through both panels */}
          {placed.map((m) => (
            <line
              key={`l-${m.id}-${m.ts}`}
              x1={m.cx}
              x2={m.cx}
              y1={labelsH - 2}
              y2={plotsBottom}
              stroke={m.kind === "onset" ? "#a1a1aa" : "#71717a"}
              strokeWidth={1}
              strokeDasharray={m.kind === "onset" ? undefined : "3 3"}
            />
          ))}

          {/* X axis */}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={height - 6} textAnchor="middle" className="fill-zinc-500 font-mono text-[10px]">
              {hhmm(t)}
            </text>
          ))}

          {/* Hover layer: shared crosshair across panels */}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(times[hover])} x2={x(times[hover])} y1={plotsTop} y2={plotsBottom} stroke="#d4d4d8" strokeWidth={1} />
              {data.series.map((s, i) => {
                const top = panelTop(i);
                const max = niceMax(Math.max(...s.points.map((p) => p.value), s.limit ?? 0) * 1.05);
                const v = s.points[hover].value;
                return <circle key={s.id} cx={x(times[hover])} cy={top + PANEL_H - (v / max) * PANEL_H} r={4} fill={SERIES_COLORS[i]} stroke="#111113" strokeWidth={2} />;
              })}
            </g>
          )}
          <rect x={M.left} y={plotsTop} width={plotW} height={plotsBottom - plotsTop} fill="transparent" onMouseMove={onMove} />
          {/* Wide invisible hit targets so the marker lines are clickable too */}
          {placed.map((m) => (
            <line
              key={`h-${m.id}-${m.ts}`}
              x1={m.cx}
              x2={m.cx}
              y1={labelsH}
              y2={plotsBottom}
              stroke="transparent"
              strokeWidth={10}
              className="cursor-pointer"
              onClick={() => open(m.id)}
              onMouseMove={(e) => onMove(e as unknown as React.MouseEvent<SVGRectElement>)}
            >
              <title>{`${markerTitle(m)} (open ${m.id})`}</title>
            </line>
          ))}
        </svg>

        {hover !== null && (
          <div
            className="pointer-events-none absolute z-10 rounded-md border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 text-xs shadow-xl"
            style={{ left: Math.min(x(times[hover]) + 10, width - 170), top: plotsTop }}
          >
            <div className="font-mono text-zinc-400">{hhmm(times[hover])} UTC</div>
            {data.series.map((s, i) => (
              <div key={s.id} className="flex items-center gap-1.5 text-zinc-200">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: SERIES_COLORS[i] }} />
                {s.label}: <span className="font-mono">{fmt(s.points[hover].value, s.unit)}</span>
              </div>
            ))}
            {placed.filter((m) => hhmm(m.ts) <= hhmm(times[hover]) && Date.parse(times[hover]) - Date.parse(m.ts) < 5 * 60_000).map((m) => (
              <div key={m.id} className="text-zinc-400">{markerTitle(m)}</div>
            ))}
          </div>
        )}
      </div>
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-zinc-500">
        <span>Dashed: changes before onset · solid: detected onset. Click a marker to open its evidence.</span>
        <details className="text-zinc-500">
          <summary className="cursor-pointer select-none hover:text-zinc-300">Data table</summary>
          <table className="mt-1 font-mono text-[11px] text-zinc-400">
            <thead>
              <tr>
                <th className="pr-4 text-left font-normal">UTC</th>
                {data.series.map((s) => (
                  <th key={s.id} className="pr-4 text-right font-normal">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {times.map((t, j) => (
                <tr key={t}>
                  <td className="pr-4">{hhmm(t)}</td>
                  {data.series.map((s) => (
                    <td key={s.id} className="pr-4 text-right">{fmt(s.points[j].value, s.unit)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </figcaption>
    </figure>
  );
}

function markerTitle(m: ChartMarker): string {
  return m.kind === "onset" ? `Detected onset ${hhmm(m.ts)}` : `${m.kind === "config" ? "Config change" : "Deploy"} ${m.id} at ${hhmm(m.ts)}`;
}
