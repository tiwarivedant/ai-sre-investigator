import type { Evidence, Hypothesis } from "@/lib/types";
import type { CorrelatedChange } from "./correlation";

/**
 * Changes the brief must account for: each needs a hypothesis that is either
 * supported or rejected, so the obvious suspect is tested rather than skipped.
 */
export interface SuspectChange {
  id: string;
  /** Why it is a suspect: "in window (-8m before onset)", "named in CHAT-003". */
  reasons: string[];
}

/** Text written by people: the incident report, chat lines, responder follow-ups. */
export interface ResponderText {
  source: string; // "the incident report", "CHAT-003", "USER-001"
  text: string;
}

/**
 * Suspects = changes in the correlation window before onset, plus changes a responder
 * names (by ID, deploy version or config key). Only changes made before onset count:
 * a change named after onset (a rollback, a mitigation flag) cannot have caused it.
 */
export function suspectChanges(changes: CorrelatedChange[], texts: ResponderText[]): SuspectChange[] {
  const out: SuspectChange[] = [];
  for (const c of changes) {
    if (c.relation === "after_onset") continue;
    const reasons: string[] = [];
    if (c.relation === "before_onset_in_window") reasons.push(`in window (${c.minutesFromOnset}m before onset)`);
    const names = changeNames(c);
    const namedIn = texts.filter((t) => names.some((n) => mentions(t.text, n))).map((t) => t.source);
    if (namedIn.length) reasons.push(`named in ${namedIn.slice(0, 3).join(", ")}${namedIn.length > 3 ? ` +${namedIn.length - 3}` : ""}`);
    if (reasons.length) out.push({ id: c.id, reasons });
  }
  return out;
}

/** How people refer to a change: its ID, a deploy's version, a config change's key or flag name. */
function changeNames(c: CorrelatedChange): string[] {
  const names = [c.id];
  if (c.kind !== "config") {
    const version = c.summary.match(/^(v?\d+(?:\.\d+)+)/)?.[1];
    if (version) names.push(version);
  } else {
    // "DB_POOL_MAX: 20 -> 80", "flag holiday_banner: false -> true"
    const key = c.summary.match(/^(?:flag\s+)?([A-Za-z][\w.-]{3,}):/)?.[1];
    if (key) names.push(key);
  }
  return names;
}

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.])${escaped}(?![\\w]|\\.\\d)`, "i").test(text);
}

/** Responder-written text in the store (chat lines, follow-ups and notes), plus the report itself. */
export function responderTexts(evidence: Evidence[], incidentInput?: string): ResponderText[] {
  const texts: ResponderText[] = incidentInput ? [{ source: "the incident report", text: incidentInput }] : [];
  for (const e of evidence) {
    const raw = e.raw as { message?: string; text?: string };
    if (e.kind === "chat") texts.push({ source: e.id, text: raw.message ?? e.title });
    else if (e.kind === "user") texts.push({ source: e.id, text: raw.text ?? e.title });
  }
  return texts;
}

/**
 * Suspects no hypothesis addresses. A hypothesis addresses a change when it is about it:
 * the change is in its supporting evidence or named in its statement. Its status
 * (active, confirmed or rejected) says how it was judged; citing the change only as
 * contradicting evidence for something else does not test it.
 */
export function untestedSuspects(suspects: SuspectChange[], hypotheses: Hypothesis[]): string[] {
  return suspects
    .filter((s) => !hypotheses.some((h) => h.supporting.includes(s.id) || new RegExp(`\\b${s.id}\\b`).test(h.statement)))
    .map((s) => s.id);
}
