import { describe, expect, it } from "vitest";
import { loadEvidenceStore } from "@/lib/evidence/loader";
import { runPreAnalysis } from "./preAnalysis";
import { chartData } from "./chartData";

describe("chartData", () => {
  it("picks the customer-facing error rate, the saturated resource with its limit, and the change/onset markers", () => {
    const store = loadEvidenceStore();
    const d = chartData(runPreAnalysis(store), store);
    expect(d.series.map((s) => [s.id, s.limit])).toEqual([
      ["MET-checkout.error_rate_pct", undefined],
      ["MET-orders_db.active_connections", 400],
    ]);
    expect(d.series[0].points).toHaveLength(13);
    expect(d.markers.map((m) => [m.id, m.ts.slice(11, 16), m.kind])).toEqual([
      ["DEP-102", "13:40", "deploy"],
      ["CFG-502", "13:52", "config"],
      ["MET-checkout.error_rate_pct", "13:55", "onset"],
    ]);
  });
});
