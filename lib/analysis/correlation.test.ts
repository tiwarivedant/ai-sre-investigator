import { describe, expect, it } from "vitest";
import type { MetricSeries } from "@/lib/evidence/records";
import { detectChangePoints } from "./changepoint";
import { correlateChanges, parseFullRollout, toChangeEvents, type ChangeEvent } from "./correlation";

const ts = (hhmm: string) => `2026-10-28T${hhmm}:00Z`;

const bucket = (i: number) => new Date(Date.parse("2026-10-28T13:30:00Z") + i * 300_000).toISOString().replace(".000Z", "Z");

function series(name: string, service: string, values: number[]): MetricSeries {
  return {
    id: `MET-${name}`,
    name,
    service,
    points: values.map((value, i) => ({ ts: bucket(i), value })),
  };
}

function change(id: string, hhmm: string, service: string, extra: Partial<ChangeEvent> = {}): ChangeEvent {
  return { id, ts: ts(hhmm), service, kind: "config", summary: id, onDeployDashboard: false, ...extra };
}

//                         13:30 13:35 13:40 13:45 13:50 13:55 14:00 14:05 14:10 14:15 14:20
const metrics = [
  series("a.errors", "a", [1, 1, 1, 1, 1, 5, 6, 6, 6, 6, 6]),
  series("b.latency", "b", [100, 100, 100, 100, 100, 100, 160, 160, 160, 100, 100]),
  series("b.errors", "b", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
];
const cps = detectChangePoints(metrics);
const onset = ts("13:55");

describe("correlateChanges", () => {
  const out = correlateChanges(
    [
      change("OLD", "12:00", "a"),
      change("NEAR", "13:52", "a"),
      change("DEPLOY", "13:40", "b", { kind: "deploy", fullRolloutTs: ts("13:47"), onDeployDashboard: true }),
      change("MITIGATE", "14:12", "b"),
      change("ALSO", "14:14", "c"),
    ],
    onset,
    cps,
    metrics,
    30,
  );
  const byId = Object.fromEntries(out.map((c) => [c.id, c]));

  it("classifies changes relative to onset and the window", () => {
    expect(byId.OLD.relation).toBe("before_onset_outside_window");
    expect(byId.NEAR.relation).toBe("before_onset_in_window");
    expect(byId.NEAR.minutesFromOnset).toBe(-3);
    expect(byId.MITIGATE.relation).toBe("after_onset");
  });

  it("measures staged deploys from when they reached 100%", () => {
    expect(byId.DEPLOY.minutesFromOnset).toBe(-8);
    expect(byId.DEPLOY.relation).toBe("before_onset_in_window");
  });

  it("reports whether the changed service's own metrics moved, and when", () => {
    expect(byId.NEAR.ownChangePoints.map((o) => o.seriesId)).toEqual(["MET-a.errors"]);
    expect(byId.NEAR.ownChangePoints[0].lagMinutes).toBe(0);
    // b's latency moves only 5m after onset (a lagging symptom), and its errors never move.
    expect(byId.DEPLOY.ownChangePoints).toEqual([{ seriesId: "MET-b.latency", ts: ts("14:00"), lagMinutes: 5 }]);
    expect(byId.DEPLOY.ownQuietSeries).toEqual(["MET-b.errors"]);
  });

  it("measures effects only for post-onset changes, and flags confounding", () => {
    expect(byId.NEAR.effects).toBeUndefined();
    const lat = byId.MITIGATE.effects?.find((e) => e.seriesId === "MET-b.latency");
    expect(lat).toEqual({ seriesId: "MET-b.latency", before: 160, after: 100, deltaPct: -37.5 });
    expect(byId.MITIGATE.effects?.find((e) => e.seriesId === "MET-a.errors")?.deltaPct).toBe(0);
    expect(byId.MITIGATE.concurrentChanges).toEqual(["ALSO"]);
    expect(byId.OLD.concurrentChanges).toEqual([]);
  });
});

describe("toChangeEvents", () => {
  it("merges deploys and config changes, sorted, with dashboard visibility", () => {
    const events = toChangeEvents(
      [{ id: "DEP-1", timestamp: ts("13:40"), service: "p", type: "code_deploy", version: "v2", author: "x", summary: "s", status: "ok", rollout: "canary 10% at 13:40, 100% at 13:47" }],
      [{ id: "CFG-1", timestamp: ts("13:30"), service: "i", source: "config-service", author: "y", change: "POOL: 1 -> 2", ticket: null }],
      "2026-10-28",
    );
    expect(events.map((e) => e.id)).toEqual(["CFG-1", "DEP-1"]);
    expect(events[0].onDeployDashboard).toBe(false);
    expect(events[1].fullRolloutTs).toBe(ts("13:47"));
  });

  it("parses rollout strings", () => {
    expect(parseFullRollout("canary 10% at 9:05, 100% at 9:20", "2026-01-01")).toBe("2026-01-01T09:20:00Z");
    expect(parseFullRollout(undefined, "2026-01-01")).toBeUndefined();
    expect(parseFullRollout("all at once", "2026-01-01")).toBeUndefined();
  });
});
