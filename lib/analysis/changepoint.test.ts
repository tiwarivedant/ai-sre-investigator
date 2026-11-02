import { describe, expect, it } from "vitest";
import type { MetricSeries } from "@/lib/evidence/records";
import { detectChangePoint, detectChangePoints, detectOnset, detectSaturation } from "./changepoint";

const bucket = (i: number) => new Date(Date.parse("2026-10-28T13:30:00Z") + i * 300_000).toISOString().replace(".000Z", "Z");

function series(name: string, values: number[], service = "svc"): MetricSeries {
  return {
    id: `MET-${name}`,
    name,
    service,
    points: values.map((value, i) => ({ ts: bucket(i), value })),
  };
}

describe("detectChangePoint", () => {
  it("flags the first bucket above 2x baseline", () => {
    const cp = detectChangePoint(series("err", [0.3, 0.3, 0.3, 0.4, 0.3, 1.1, 6.8, 7.9]));
    expect(cp?.ts).toBe("2026-10-28T13:55:00Z");
    expect(cp?.rule).toBe("ratio");
    expect(cp?.sustained).toBe(true);
    expect(cp?.peak).toBe(7.9);
    expect(cp?.recoveredAt).toBeUndefined();
  });

  it("catches a sharp shift on a capped series that can never double", () => {
    // Connections near a 400 ceiling: +35%, far outside baseline noise.
    const cp = detectChangePoint(series("conns", [238, 241, 247, 252, 256, 331, 393, 397]));
    expect(cp?.ts).toBe("2026-10-28T13:55:00Z");
    expect(cp?.rule).toBe("deviation");
  });

  it("ignores slow drift", () => {
    expect(detectChangePoint(series("disk", [85.9, 86.2, 86.3, 86.5, 86.6, 86.8, 87.0, 87.9]))).toBeNull();
  });

  it("ignores flat series, including perfectly constant ones", () => {
    expect(detectChangePoint(series("flat", [0.19, 0.2, 0.21, 0.2, 0.22, 0.21, 0.23, 0.2]))).toBeNull();
    expect(detectChangePoint(series("const", [400, 400, 400, 400, 400, 400]))).toBeNull();
  });

  it("does not flag decreases", () => {
    expect(detectChangePoint(series("down", [100, 100, 100, 100, 20, 10]))).toBeNull();
  });

  it("marks one-bucket blips as not sustained", () => {
    const cp = detectChangePoint(series("blip", [10, 10, 10, 10, 50, 10, 10]));
    expect(cp?.sustained).toBe(false);
    expect(cp?.recoveredAt).toBe("2026-10-28T13:55:00Z");
  });

  it("reports recovery once the series stays back in range", () => {
    const cp = detectChangePoint(series("batch", [20, 22, 21, 20, 22, 91, 89, 88, 22, 21]));
    expect(cp?.ts).toBe("2026-10-28T13:55:00Z");
    expect(cp?.recoveredAt).toBe("2026-10-28T14:10:00Z");
  });

  it("returns null when there is no data beyond the baseline window", () => {
    expect(detectChangePoint(series("short", [1, 2, 3, 4]))).toBeNull();
  });
});

describe("detectOnset", () => {
  it("is the earliest sustained change-point, skipping blips", () => {
    const cps = detectChangePoints([
      series("blip", [10, 10, 10, 10, 50, 10, 10, 10]),
      series("late", [1, 1, 1, 1, 1, 1, 5, 5]),
      series("early", [1, 1, 1, 1, 1, 5, 5, 5]),
    ]);
    expect(detectOnset(cps)).toBe("2026-10-28T13:55:00Z");
  });
});

describe("detectSaturation", () => {
  it("pairs usage with its max_ series and reports peak utilisation", () => {
    const sat = detectSaturation([
      series("db.active_connections", [200, 250, 331, 397]),
      series("db.max_connections", [400, 400, 400, 400]),
    ]);
    expect(sat).toHaveLength(1);
    expect(sat[0].seriesId).toBe("MET-db.active_connections");
    expect(sat[0].peakUtilizationPct).toBe(99.25);
    expect(sat[0].firstOver80Ts).toBe("2026-10-28T13:40:00Z");
  });
});
