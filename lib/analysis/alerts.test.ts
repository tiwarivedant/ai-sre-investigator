import { describe, expect, it } from "vitest";
import type { AlertRecord, ServiceCatalog } from "@/lib/evidence/records";
import { assessAlerts, groupAlerts } from "./alerts";
import { maskNumbers } from "./logs";

const catalog: ServiceCatalog = {
  services: {
    frontend: { depends_on: ["checkout", "search"] },
    checkout: { depends_on: ["orders"] },
    orders: { depends_on: ["db"] },
    reporting: { depends_on: ["db"] },
    search: { depends_on: [] },
  },
  resources: { db: { type: "postgres", shared_by: ["orders", "reporting"] }, "log-host": { type: "vm" } },
};

const alert = (id: string, hhmm: string, service: string, severity: AlertRecord["severity"], extra: Partial<AlertRecord> = {}): AlertRecord => ({
  id,
  timestamp: `2026-10-28T${hhmm}:00Z`,
  source: "dd",
  service,
  severity,
  title: `${service} ${id}`,
  status: "open",
  ...extra,
});

describe("assessAlerts", () => {
  const alerts = [
    alert("A1", "14:00", "checkout", "critical"),
    alert("A2", "14:01", "db", "warning"),
    alert("A3", "13:20", "log-host", "warning"),
    alert("A4", "13:50", "search", "warning", { title: "flap", status: "resolved", resolved_at: "2026-10-28T13:52:00Z" }),
    alert("A5", "14:05", "search", "warning", { title: "flap", status: "resolved", resolved_at: "2026-10-28T14:06:00Z" }),
    alert("A6", "14:03", "reporting", "info"),
    alert("A7", "13:30", "gateway", "warning"),
  ];
  const byId = Object.fromEntries(assessAlerts(alerts, catalog, "2026-10-28T13:55:00Z").map((a) => [a.id, a]));

  it("keeps in-path signals clean", () => {
    expect(byId.A1.likelyNoise).toBe(false);
    expect(byId.A2.flags).toEqual([]);
  });

  it("treats services sharing a resource with the failing path as in the blast radius", () => {
    expect(byId.A6.flags).not.toContain("outside_blast_radius");
    expect(byId.A6.flags).toContain("info_severity");
    expect(byId.A6.likelyNoise).toBe(true);
  });

  it("flags flapping, unrelated and unknown-service alerts", () => {
    expect(byId.A3.flags).toEqual(["outside_blast_radius", "preceded_onset"]);
    expect(byId.A4.flags).toEqual(expect.arrayContaining(["resolved_quickly", "repeated_flap", "outside_blast_radius"]));
    expect(byId.A5.likelyNoise).toBe(true);
    expect(byId.A7.flags).toContain("not_in_catalog");
  });

  it("never calls a critical alert noise", () => {
    const out = assessAlerts([alert("C", "14:00", "gateway", "critical")], catalog, undefined);
    expect(out[0].flags).toContain("not_in_catalog");
    expect(out[0].likelyNoise).toBe(false);
  });
});

describe("groupAlerts", () => {
  it("groups per service within the window and tracks max severity", () => {
    const groups = groupAlerts([
      alert("1", "13:00", "db", "warning"),
      alert("2", "13:20", "db", "critical"),
      alert("3", "14:30", "db", "warning"),
      alert("4", "13:10", "checkout", "critical"),
    ]);
    expect(groups.map((g) => g.alertIds)).toEqual([["1", "2"], ["4"], ["3"]]);
    expect(groups[0].maxSeverity).toBe("critical");
  });
});

describe("maskNumbers", () => {
  it("masks values but keeps identifiers", () => {
    expect(maskNumbers("inventory reserve timed out after 3000ms")).toBe("inventory reserve timed out after Nms");
    expect(maskNumbers("3DS2 challenge config missing")).toBe("3DS2 challenge config missing");
    expect(maskNumbers("POST /v1/orders 500: orders-service returned 503")).toBe("POST /v1/orders N: orders-service returned N");
  });
});
