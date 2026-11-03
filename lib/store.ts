import fs from "node:fs";
import path from "node:path";
import type { ProviderName } from "@/lib/llm";
import type { Evidence, InvestigationState } from "@/lib/types";

/**
 * In-memory map backed by one JSON file per investigation under
 * .investigations/. The provider-native conversation is persisted alongside the
 * state so a follow-up can resume the agent exactly where it left off (on the
 * same provider: histories are not portable between providers).
 *
 * Read-only sample investigations live in samples/investigations/<name>.json
 * (id "sample-<name>") so they can be browsed without an API key.
 */
export interface StoredInvestigation {
  state: InvestigationState;
  provider: ProviderName;
  model: string;
  history: unknown[];
  userEvidence: Evidence[];
  /** Shipped example: browsable, never resumed. */
  sample?: boolean;
  /** For samples: where the recorded model turns came from. */
  recordedFrom?: string;
  /** USER- evidence recorded by actions (notes, resolve, reopen) that the agent hasn't been shown yet. */
  undeliveredNotes?: string[];
}

export interface InvestigationSummary {
  id: string;
  incidentInput: string;
  status: InvestigationState["status"];
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
  provider: ProviderName;
  model: string;
  sample: boolean;
  briefSource?: InvestigationState["briefSource"];
  incidentStatus?: InvestigationState["incidentStatus"];
  /** Not resolved (and not a finished sample). */
  open: boolean;
  topHypothesis: { id: string; statement: string; confidence: number; status: string } | null;
  followUps: number;
}

// INVESTIGATIONS_DIR lets automated tests use their own folder instead of yours.
export const INVESTIGATIONS_DIR = process.env.INVESTIGATIONS_DIR ? path.resolve(process.env.INVESTIGATIONS_DIR) : path.join(process.cwd(), ".investigations");
const DIR = INVESTIGATIONS_DIR;
export const SAMPLES_DIR = path.join(process.cwd(), "samples", "investigations");
const SAMPLE_PREFIX = "sample-";

// On globalThis: Next.js dev bundles each route separately, and the route that
// streams a run must see the same in-memory state as the route that started it.
const g = globalThis as { __investigations?: Map<string, StoredInvestigation> };
const mem = (g.__investigations ??= new Map<string, StoredInvestigation>());

export function saveInvestigation(inv: StoredInvestigation) {
  if (inv.sample) throw new Error("Sample investigations are read-only");
  mem.set(inv.state.id, inv);
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${inv.state.id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(inv, null, 2));
  fs.renameSync(`${file}.tmp`, file); // atomic replace
}

export function loadInvestigation(id: string): StoredInvestigation | undefined {
  if (!/^[\w-]+$/.test(id)) return undefined;
  const cached = mem.get(id);
  if (cached) return cached;

  if (id.startsWith(SAMPLE_PREFIX)) {
    const file = path.join(SAMPLES_DIR, `${id.slice(SAMPLE_PREFIX.length)}.json`);
    if (!fs.existsSync(file)) return undefined;
    const inv = { ...(JSON.parse(fs.readFileSync(file, "utf8")) as StoredInvestigation), sample: true };
    mem.set(id, inv);
    return inv;
  }

  const file = path.join(DIR, `${id}.json`);
  if (!fs.existsSync(file)) return undefined;
  const inv = JSON.parse(fs.readFileSync(file, "utf8")) as StoredInvestigation;
  // Saved as running but not in this process's memory: the server stopped mid-run.
  // Mark it so it can be followed up instead of looking busy forever.
  if (inv.state.status === "running") {
    inv.state.status = "partial";
    inv.state.statusReason = "Interrupted: the server stopped during this run. Showing the last saved state.";
  }
  mem.set(id, inv);
  return inv;
}

export function summarize(inv: StoredInvestigation): InvestigationSummary {
  const s = inv.state;
  const top = s.hypotheses.find((h) => h.status !== "rejected") ?? null;
  return {
    id: s.id,
    incidentInput: s.incidentInput,
    status: s.status,
    statusReason: s.statusReason,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    provider: inv.provider,
    model: inv.model,
    sample: !!inv.sample,
    briefSource: s.briefSource,
    incidentStatus: s.incidentStatus,
    open: s.incidentStatus !== "resolved",
    topHypothesis: top && { id: top.id, statement: top.statement, confidence: top.confidence, status: top.status },
    followUps: s.revisions.length,
  };
}

/** Saved investigations (newest first) and the shipped samples. */
export function listInvestigations(limit = 50): { recent: InvestigationSummary[]; samples: InvestigationSummary[] } {
  const ids = (dir: string, prefix = "") =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => prefix + f.slice(0, -5))
      : [];
  const load = (list: string[]) =>
    list
      .map((id) => {
        try {
          return loadInvestigation(id);
        } catch {
          return undefined; // a corrupt file shouldn't break the list
        }
      })
      .filter((x): x is StoredInvestigation => !!x)
      .map(summarize)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Samples are numbered (01-, 02-, ...): show them in that order, not by date.
  // Open incidents first (newest first), then resolved ones.
  const recent = load(ids(DIR)).sort((a, b) => Number(b.open) - Number(a.open) || b.updatedAt.localeCompare(a.updatedAt));
  return { recent: recent.slice(0, limit), samples: load(ids(SAMPLES_DIR, SAMPLE_PREFIX)).sort((a, b) => a.id.localeCompare(b.id)) };
}

/** Most recently updated saved investigation, for CLI convenience. */
export function latestInvestigationId(): string | undefined {
  if (!fs.existsSync(DIR)) return undefined;
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ id: f.slice(0, -5), mtime: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.id;
}
