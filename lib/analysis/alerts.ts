import type { AlertRecord, ServiceCatalog } from "@/lib/evidence/records";
import { blastRadius, isKnown } from "./topology";
import { minutesBetween } from "./correlation";

export type NoiseFlag =
  | "resolved_quickly" // auto-resolved within a few minutes
  | "repeated_flap" // same alert fired and resolved more than once
  | "info_severity"
  | "outside_blast_radius" // service has no dependency path to the services in trouble
  | "not_in_catalog"
  | "preceded_onset"; // was already firing well before the incident started

export interface AlertAssessment {
  id: string;
  service: string;
  severity: AlertRecord["severity"];
  title: string;
  flags: NoiseFlag[];
  likelyNoise: boolean;
}

export interface AlertGroup {
  service: string;
  alertIds: string[];
  first: string;
  last: string;
  maxSeverity: AlertRecord["severity"];
}

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 } as const;
// Flags that on their own are enough to call a non-critical alert noise.
const NOISE_FLAGS: NoiseFlag[] = ["resolved_quickly", "repeated_flap", "info_severity", "outside_blast_radius", "not_in_catalog"];

/** The services in trouble: those with critical alerts. */
export function focusServices(alerts: AlertRecord[]): string[] {
  return [...new Set(alerts.filter((a) => a.severity === "critical").map((a) => a.service))];
}

export function assessAlerts(
  alerts: AlertRecord[],
  catalog: ServiceCatalog,
  onset: string | undefined,
  opts = { quickResolveMinutes: 5, precededOnsetMinutes: 15 },
): AlertAssessment[] {
  const radius = blastRadius(catalog, focusServices(alerts));
  const titleCounts = new Map<string, number>();
  for (const a of alerts) titleCounts.set(a.title, (titleCounts.get(a.title) ?? 0) + 1);

  return alerts.map((a) => {
    const flags: NoiseFlag[] = [];
    if (a.status === "resolved" && a.resolved_at && minutesBetween(a.timestamp, a.resolved_at) <= opts.quickResolveMinutes)
      flags.push("resolved_quickly");
    if ((titleCounts.get(a.title) ?? 0) > 1 && a.status === "resolved") flags.push("repeated_flap");
    if (a.severity === "info") flags.push("info_severity");
    if (!isKnown(catalog, a.service)) flags.push("not_in_catalog");
    else if (!radius.has(a.service)) flags.push("outside_blast_radius");
    if (onset && minutesBetween(a.timestamp, onset) > opts.precededOnsetMinutes) flags.push("preceded_onset");

    const likelyNoise = a.severity !== "critical" && flags.some((f) => NOISE_FLAGS.includes(f));
    return { id: a.id, service: a.service, severity: a.severity, title: a.title, flags, likelyNoise };
  });
}

/** Group alerts per service when they fire within `windowMinutes` of the previous one. */
export function groupAlerts(alerts: AlertRecord[], windowMinutes = 30): AlertGroup[] {
  const groups: AlertGroup[] = [];
  const sorted = [...alerts].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const a of sorted) {
    const g = groups.findLast((x) => x.service === a.service);
    if (g && minutesBetween(g.last, a.timestamp) <= windowMinutes) {
      g.alertIds.push(a.id);
      g.last = a.timestamp;
      if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[g.maxSeverity]) g.maxSeverity = a.severity;
    } else {
      groups.push({ service: a.service, alertIds: [a.id], first: a.timestamp, last: a.timestamp, maxSeverity: a.severity });
    }
  }
  return groups;
}
