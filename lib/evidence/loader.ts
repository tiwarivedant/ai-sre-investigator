import fs from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import type { Evidence } from "@/lib/types";
import type {
  AlertRecord,
  ConfigChangeRecord,
  DeployRecord,
  LogRecord,
  MetricsFile,
  MetricSeries,
  ServiceCatalog,
  KnowledgeDoc,
} from "./records";

export const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

/**
 * Every piece of evidence the system knows about, keyed by a stable ID.
 * Typed record arrays are kept alongside so deterministic analysis does not
 * have to re-parse `raw`.
 */
export class EvidenceStore {
  readonly items = new Map<string, Evidence>();
  alerts: AlertRecord[] = [];
  logs: LogRecord[] = [];
  deploys: DeployRecord[] = [];
  configChanges: ConfigChangeRecord[] = [];
  metrics: MetricSeries[] = [];
  catalog: ServiceCatalog = { services: {}, resources: {} };
  knowledge: KnowledgeDoc[] = [];
  /** Day the scenario's HH:MM timestamps belong to (from metrics/chat headers). */
  incidentDate = "";

  add(e: Evidence) {
    if (this.items.has(e.id)) throw new Error(`Duplicate evidence ID ${e.id}`);
    this.items.set(e.id, e);
  }

  get(id: string): Evidence | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  list(): Evidence[] {
    return [...this.items.values()];
  }

  /** Pasted follow-up text becomes first-class, citable evidence (USER-001, ...). */
  /** `action` tags evidence recorded by a responder action (note/resolve/reopen) rather than a follow-up message. */
  addUserEvidence(text: string, at = new Date().toISOString(), action?: "note" | "resolve" | "reopen"): Evidence {
    const n = this.list().filter((e) => e.kind === "user").length + 1;
    const label = action === "resolve" ? "Resolved: " : action === "reopen" ? "Reopened: " : action === "note" ? "Note: " : "";
    const e: Evidence = {
      id: `USER-${String(n).padStart(3, "0")}`,
      kind: "user",
      timestamp: at,
      title: oneLine(`${label}${text}`, 120),
      raw: action ? { text, action } : { text },
    };
    this.add(e);
    return e;
  }
}

export function loadEvidenceStore(dataDir = DEFAULT_DATA_DIR): EvidenceStore {
  const store = new EvidenceStore();
  const read = (f: string) => fs.readFileSync(path.join(dataDir, f), "utf8");

  // Alerts
  store.alerts = JSON.parse(read("alerts.json"));
  for (const a of store.alerts) {
    store.add({
      id: a.id,
      kind: "alert",
      timestamp: a.timestamp,
      service: a.service,
      title: `[${a.severity}] ${a.title}${a.value ? ` (${a.value})` : ""}${a.status === "resolved" ? " - resolved" : ""}`,
      raw: a,
    });
  }

  // Logs
  store.logs = read("logs.jsonl")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  for (const l of store.logs) {
    store.add({
      id: l.id,
      kind: "log",
      timestamp: l.timestamp,
      service: l.service,
      title: `${l.level} ${l.service}: ${oneLine(l.message, 140)}`,
      raw: l,
    });
  }

  // Deploys + config changes
  store.deploys = JSON.parse(read("deploys.json"));
  for (const d of store.deploys) {
    store.add({
      id: d.id,
      kind: "deploy",
      timestamp: d.timestamp,
      service: d.service,
      title: `${d.type === "rollback" ? "Rollback" : "Deploy"} ${d.service} ${d.version}: ${d.summary}`,
      raw: d,
    });
  }
  store.configChanges = JSON.parse(read("config-changes.json"));
  for (const c of store.configChanges) {
    store.add({
      id: c.id,
      kind: "config",
      timestamp: c.timestamp,
      service: c.service,
      title: `Config ${c.service} (${c.source}, by ${c.author}): ${c.change}`,
      raw: c,
    });
  }

  // Metrics: one evidence item per series
  const metricsFile: MetricsFile = JSON.parse(read("metrics.json"));
  store.incidentDate = extractDate(metricsFile.description) ?? "";
  if (!store.incidentDate) throw new Error("metrics.json description must contain the YYYY-MM-DD date");
  const isoTimes = metricsFile.timestamps.map((hhmm) => toIso(store.incidentDate, hhmm));
  for (const [name, values] of Object.entries(metricsFile.series)) {
    const series: MetricSeries = { name, id: `MET-${name}`, service: metricService(name), points: values.map((v, i) => ({ ts: isoTimes[i], value: v })) };
    store.metrics.push(series);
    store.add({
      id: series.id,
      kind: "metric",
      service: series.service,
      timestamp: isoTimes[0],
      title: `Metric ${name} (${isoTimes.length} x 5-min buckets)`,
      raw: { name, timestamps: metricsFile.timestamps, values, notes: metricsFile.notes.filter((n) => n.includes(name)) },
    });
  }

  // Service catalog (not itself citable evidence, but used by tools)
  store.catalog = loadYaml(read("services.yaml")) as ServiceCatalog;

  // Runbooks + past incidents
  for (const f of listMd(path.join(dataDir, "runbooks"))) {
    const text = fs.readFileSync(f, "utf8");
    const id = `RB-${path.basename(f, ".md")}`;
    const doc: KnowledgeDoc = { id, kind: "runbook", title: firstHeading(text) ?? id, text };
    store.knowledge.push(doc);
    store.add({ id, kind: "runbook", title: doc.title, raw: { file: `runbooks/${path.basename(f)}`, text } });
  }
  for (const f of listMd(path.join(dataDir, "past-incidents"))) {
    const text = fs.readFileSync(f, "utf8");
    const id = path.basename(f, ".md"); // files are already named INC-xxxx
    const doc: KnowledgeDoc = { id, kind: "incident", title: firstHeading(text) ?? id, text };
    store.knowledge.push(doc);
    store.add({ id, kind: "incident", title: doc.title, raw: { file: `past-incidents/${path.basename(f)}`, text } });
  }

  // Chat transcript: "**14:06 Name (team):** message" -> CHAT-001...
  const chat = read("chat-transcript.md");
  const chatDate = extractDate(chat) ?? store.incidentDate;
  let chatN = 0;
  for (const line of chat.split("\n")) {
    const m = line.match(/^\*\*(\d{1,2}:\d{2})\s+([^:*]+?):\*\*\s*(.*)$/);
    if (!m) continue;
    const [, hhmm, speaker, message] = m;
    const id = `CHAT-${String(++chatN).padStart(3, "0")}`;
    store.add({
      id,
      kind: "chat",
      timestamp: toIso(chatDate, hhmm),
      title: `${speaker}: ${oneLine(message, 120)}`,
      raw: { time: hhmm, speaker, message },
    });
  }

  // Customer impact notes: each bullet -> CUST-001...
  const cust = read("customer-impact.md");
  let custN = 0;
  for (const line of cust.split("\n")) {
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (!m) continue;
    const note = m[1];
    const t = note.match(/^(\d{1,2}:\d{2})\b/);
    store.add({
      id: `CUST-${String(++custN).padStart(3, "0")}`,
      kind: "customer",
      timestamp: t ? toIso(store.incidentDate, t[1]) : undefined,
      title: oneLine(note, 120),
      raw: { note },
    });
  }

  return store;
}

/** "checkout.error_rate_pct" -> "checkout-service"; "orders_db.cpu_pct" -> "orders-db". */
export function metricService(series: string): string {
  const prefix = series.split(".")[0];
  if (prefix.endsWith("_db")) return prefix.replace("_", "-");
  if (prefix.includes("_")) return prefix.replace(/_/g, "-");
  return `${prefix}-service`;
}

export function toIso(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":");
  return `${date}T${h.padStart(2, "0")}:${m}:00Z`;
}

function extractDate(text: string): string | undefined {
  return text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
}

function listMd(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(dir, f));
}

function firstHeading(md: string): string | undefined {
  return md.match(/^#\s+(.+)$/m)?.[1].trim();
}

export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
