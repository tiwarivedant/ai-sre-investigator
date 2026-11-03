import type { EvidenceStore } from "@/lib/evidence/loader";
import type { PreAnalysis } from "@/lib/analysis/preAnalysis";
import { Bm25Index, tokenize } from "@/lib/retrieval/bm25";
import { cleanFollowUp } from "@/lib/text";
import { checkCoverage, whatToProvide } from "@/lib/analysis/coverage";
import { assessRisk } from "./policy";
import { evidenceFollowUps, followUpClasses } from "@/lib/analysis/followups";
import type { ContributingFactor, InvestigationState, NextAction, RepeatIncident, SimilarIncident, TimelineEntry } from "@/lib/types";

// Deterministic checks recomputed after every brief update. Code does the
// retrieval and bookkeeping; the agent still owns the judgment.

const incidentIndexes = new WeakMap<EvidenceStore, Bm25Index>();
const MIN_SCORE = 4;
const MIN_LEAD = 2; // for rejected hypotheses, the best match must clearly beat the runner-up

/**
 * Past incidents matched to hypotheses by BM25 over the incident write-ups.
 * Every live (non-rejected) hypothesis gets its best match above the score
 * floor: a likely cause should always be checked against history. Rejected
 * hypotheses only get a match that clearly beats the runner-up. Each incident
 * goes to the hypothesis it matches best; entries the agent wrote take precedence.
 */
export function similarIncidents(state: InvestigationState, store: EvidenceStore): SimilarIncident[] {
  let index = incidentIndexes.get(store);
  if (!index) incidentIndexes.set(store, (index = new Bm25Index(store.knowledge.filter((d) => d.kind === "incident"))));

  const best = new Map<string, { score: number; hypothesisId: string; status: string }>();
  for (const h of state.hypotheses) {
    const [top, second] = index.search(`${h.statement} ${h.reasoning}`, 2);
    if (!top || top.score < MIN_SCORE) continue;
    if (h.status === "rejected" && second && top.score < MIN_LEAD * second.score) continue;
    const prev = best.get(top.id);
    if (!prev || top.score > prev.score) best.set(top.id, { score: top.score, hypothesisId: h.id, status: h.status });
  }

  const fromAgent = (state.similarIncidents ?? []).filter((s) => s.source === "agent");
  const retrieved: SimilarIncident[] = [...best.entries()]
    .filter(([id]) => !fromAgent.some((a) => a.incidentId === id))
    .map(([id, m]) => {
      const doc = store.knowledge.find((d) => d.id === id)!;
      return {
        incidentId: id,
        hypothesisId: m.hypothesisId,
        similarity: `Resembles ${m.hypothesisId} (${m.status}). ${doc.title.replace(/^INC-\d+:\s*/, "")}: ${incidentSummary(doc.text)}`.trim(),
        lesson: incidentLesson(doc.text),
        source: "retrieval" as const,
      };
    });
  return [...fromAgent, ...retrieved];
}

/** First sentence of a write-up's Summary section. */
export function incidentSummary(md: string): string {
  const section = md.split(/^##\s+/m).find((sec) => sec.startsWith("Summary"));
  const body = section?.slice("Summary".length).trim().replace(/\*\*?|`/g, "") ?? "";
  return body.match(/^.+?[.!?](\s|$)/s)?.[0].trim() ?? body.split("\n")[0] ?? "";
}

/** The most useful line of a write-up: what went poorly, else its key signal, else the resolution. */
export function incidentLesson(md: string): string {
  for (const heading of ["What went poorly", "Key signals", "Resolution", "Summary"]) {
    const section = md.split(/^##\s+/m).find((s) => s.startsWith(heading));
    if (!section) continue;
    const body = section.slice(heading.length).trim();
    const first = body.match(/^\s*[-*]\s+(.+)$/m)?.[1] ?? body.split("\n").find((l) => l.trim());
    if (first) return first.replace(/\*\*?|`/g, "").trim();
  }
  return "";
}

/**
 * Sustained metric anomalies the brief never addresses. A change-point counts
 * as explained when its service appears in evidence the brief uses to explain
 * something (a non-rejected hypothesis, a key signal, or a noise entry) or is
 * named in the explanation itself (summary, impact, live hypothesis
 * statements; not reasoning, which often names a service to rule it out). Mentioning it only in the timeline or under a rejected
 * hypothesis does not count.
 */
export function unexplainedSignals(state: InvestigationState, pa: PreAnalysis, store: EvidenceStore): NonNullable<InvestigationState["unexplained"]> {
  const explainingIds = [
    ...state.hypotheses.filter((h) => h.status !== "rejected").flatMap((h) => [...h.supporting, ...h.contradicting]),
    ...state.keySignals.map((k) => k.evidenceId),
    ...state.noise.map((k) => k.evidenceId),
  ];
  const coveredServices = new Set(explainingIds.map((id) => store.get(id)?.service).filter(Boolean));
  const cited = new Set(explainingIds);
  // A service the explanation states is affected is covered even without a citation ("...failing checkout").
  // Only the statements of what is happening count: reasoning and key signals often name a service to rule it out.
  const explanation = [state.summary, state.impact, ...state.hypotheses.filter((h) => h.status !== "rejected").map((h) => h.statement)]
    .join(" ")
    .toLowerCase();
  const named = (service: string) => new RegExp(`\\b${service.replace(/-service$/, "").replace(/[-_]/g, "[-_ ]?")}\\b`).test(explanation);

  // Citing an anomaly's ID, or the same-service alert/log that explains it, anywhere in a hypothesis
  // (any status, including its reasoning) or a key signal marks it explained: the brief addressed it.
  const citedAnywhere = new Set(
    [
      ...state.hypotheses.flatMap((h) => [...h.supporting, ...h.contradicting, ...citedIn(h.statement), ...citedIn(h.reasoning)]),
      ...state.keySignals.flatMap((k) => [k.evidenceId, ...citedIn(k.why)]),
    ],
  );

  return pa.changePoints
    .filter((c) => c.sustained && !cited.has(c.seriesId) && !coveredServices.has(c.service) && !named(c.service))
    .map((c) => ({
      evidenceId: c.seriesId,
      what: `${c.series} rose ${c.baseline} -> ${c.value} at ${c.ts.slice(11, 16)}${c.recoveredAt ? `, recovered ${c.recoveredAt.slice(11, 16)}` : ""}`,
      related: relatedEvidence(c.seriesId, pa, store),
      service: c.service,
    }))
    .filter((u) => {
      if (citedAnywhere.has(u.evidenceId)) return false;
      // Only same-service alerts and logs count; a change that merely coincided does not explain the anomaly.
      const ownEvidence = u.related.filter((r) => {
        const e = store.get(r.evidenceId);
        return e?.service === u.service && (e.kind === "alert" || e.kind === "log");
      });
      return !ownEvidence.some((r) => citedAnywhere.has(r.evidenceId));
    })
    .map(({ service: _s, ...rest }) => rest);
}

const CITATION = /\b(?:ALR|LOG|DEP|CFG|CHAT|CUST|USER)-\d+\b|\bINC-\d+\b|\bRB-[a-z0-9-]+\b|\bMET-[a-z0-9_]+\.[a-z0-9_]+\b/g;
const citedIn = (text: string | undefined) => text?.match(CITATION) ?? [];

// --- Repeat incidents, contributing factors, prevention ---------------------

/** Unchecked action items ("- [ ] ...") from a past incident write-up. */
export function openActionItems(md: string): string[] {
  return [...md.matchAll(/^\s*[-*]\s+\[ \]\s+(.+)$/gm)].map((m) =>
    m[1].replace(/\(\s*\*{0,2}open\*{0,2}\s*\)/i, "").replace(/\*\*?|`/g, "").trim(),
  );
}

/**
 * A matched past incident behind a live hypothesis that left action items
 * open: the same failure was allowed to happen again.
 */
export function repeatIncident(state: InvestigationState, store: EvidenceStore): RepeatIncident | undefined {
  const live = new Set(state.hypotheses.filter((h) => h.status !== "rejected").map((h) => h.id));
  for (const s of state.similarIncidents ?? []) {
    if (s.hypothesisId && !live.has(s.hypothesisId)) continue;
    const doc = store.knowledge.find((d) => d.id === s.incidentId);
    const open = doc ? openActionItems(doc.text) : [];
    if (open.length) return { incidentId: s.incidentId, hypothesisId: s.hypothesisId ?? state.hypotheses[0]?.id ?? "", openActionItems: open };
  }
  return undefined;
}

/** Factors code can establish from the data. The agent adds the ones that need judgment. */
export function derivedFactors(state: InvestigationState, pa: PreAnalysis, store: EvidenceStore, repeat?: RepeatIncident): ContributingFactor[] {
  const factors: ContributingFactor[] = [];
  if (repeat) {
    for (const item of repeat.openActionItems)
      factors.push({ factor: `Safeguard still missing: "${item}" was an action item from ${repeat.incidentId} and is still open.`, evidence: [repeat.incidentId], source: "code" });
  }
  // A cause hidden from where responders look first (the deploy dashboard).
  const cited = new Set(state.hypotheses.filter((h) => h.status !== "rejected").flatMap((h) => h.supporting));
  const pastDoc = repeat && store.knowledge.find((d) => d.id === repeat.incidentId);
  for (const c of pa.changes) {
    if (c.onDeployDashboard || c.relation !== "before_onset_in_window" || !cited.has(c.id)) continue;
    const pastToo = pastDoc && /deploy dashboard/i.test(pastDoc.text);
    factors.push({
      factor: `${c.id} was a hot-reloaded ${c.kind} change (${c.service}) that does not appear on the deploy dashboard, so a deploy-focused search misses it${pastToo ? `; ${repeat!.incidentId} hit the same visibility gap` : ""}.`,
      evidence: pastToo ? [c.id, repeat!.incidentId] : [c.id],
      source: "code",
    });
  }
  return factors;
}

export function preventionActions(repeat: RepeatIncident | undefined): Omit<NextAction, "risk" | "riskReason">[] {
  return (repeat?.openActionItems ?? []).map((item) => ({
    action: `Close ${repeat!.incidentId}'s open action item: ${item}`,
    type: "prevention",
    phase: "prevention",
    evidence: [repeat!.incidentId],
    source: "code",
  }));
}

/** Rough textual overlap, to avoid adding a code item the agent already wrote. */
export function overlaps(a: string, b: string, threshold = 0.5): boolean {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / Math.max(1, Math.min(ta.size, tb.size)) >= threshold;
}

/** Does an agent action already cover this open action item? Compared to the item itself, not our wrapper text. */
const coversItem = (action: string, item: string) => overlaps(action, item, 0.4);

/** Evidence near an unexplained anomaly, for a human (or the agent) to judge. Never an explanation by itself. */
export function relatedEvidence(seriesId: string, pa: PreAnalysis, store: EvidenceStore): { evidenceId: string; why: string }[] {
  const cp = pa.changePoints.find((c) => c.seriesId === seriesId);
  if (!cp) return [];
  const from = new Date(Date.parse(cp.ts) - 5 * 60_000).toISOString();
  const to = cp.recoveredAt ?? "9999";
  const out: { evidenceId: string; why: string }[] = [];

  for (const a of store.alerts)
    if (a.service === cp.service && a.timestamp >= from && a.timestamp <= to)
      out.push({ evidenceId: a.id, why: a.note ? `alert note: ${a.note}` : `alert: ${a.title}` });

  const seen = new Set<string>();
  for (const l of store.logs) {
    if (l.service !== cp.service || l.level === "INFO" || l.timestamp < from || l.timestamp > to) continue;
    const key = l.message.replace(/\d+/g, "N");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ evidenceId: l.id, why: `log: ${l.message}` });
  }

  for (const c of pa.changes) {
    const e = c.effects?.find((x) => x.seriesId === seriesId && Math.abs(x.deltaPct) >= 15);
    if (e)
      out.push({
        evidenceId: c.id,
        why: `series moved ${e.deltaPct}% in the 15 min after this change${c.concurrentChanges.length ? ` (confounded with ${c.concurrentChanges.join(", ")})` : ""}`,
      });
  }
  return out.slice(0, 5);
}


/**
 * When an event happened, from the evidence itself: a metric's change-point,
 * otherwise the record's own timestamp. Never from the LLM.
 */
export function eventTime(id: string, pa: PreAnalysis, store: EvidenceStore): string | undefined {
  if (id.startsWith("MET-")) return pa.changePoints.find((c) => c.seriesId === id)?.ts;
  return store.get(id)?.timestamp;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Brief text that contradicts what the hypotheses (or the metrics) say. */
export function consistencyIssues(state: InvestigationState, onset?: string, notEvidence: Set<string> = new Set()): string[] {
  const issues: string[] = [];
  // The summary describes the incident, not how a follow-up was handled.
  // (Citing an evidence follow-up is fine: "the owner confirmed CFG-502 (USER-001)".)
  const leadSentence = state.summary.split(/(?<=[.!?])\s/)[0] ?? "";
  const citesNonEvidence = (leadSentence.match(/\bUSER-\d+\b/g) ?? []).some((id) => notEvidence.has(id));
  if (citesNonEvidence || /\b(instruct(s|ed|ion)?|ignor(e|ed|ing) (it|this|that|the)|not acting on|won'?t act|tells me to|told me to|asked me to)\b/i.test(leadSentence))
    issues.push("summary leads with how a follow-up was handled; describe the incident (follow-up handling is shown separately)");
  // When the report names something the data can't see, the summary must say so first.
  const cov = state.coverage;
  if (cov && cov.verdict !== "covered" && cov.uncovered.length && state.summary) {
    const firstSentence = state.summary.split(/(?<=[.!?])\s/)[0].toLowerCase();
    if (!cov.uncovered.some((t) => firstSentence.includes(t.replace(/-service$/, ""))))
      issues.push(`summary does not lead with the reported ${cov.uncovered.join("/")} symptom, which has no evidence in the data; say that first`);
  }
  if (cov?.verdict === "none" && cov.uncovered.length) {
    const named = (text: string) => cov.uncovered.some((t) => text.toLowerCase().includes(t.replace(/-service$/, "")));
    if (/\b(the )?(actual|real|true) (incident|problem|issue|cause)\b/i.test(state.summary))
      issues.push(`summary calls another incident the actual one; the ${cov.uncovered.join("/")} report may be right and simply not in this data`);
    const offTopic = state.hypotheses.filter((h) => h.status !== "rejected" && !named(`${h.statement}`)).map((h) => h.id);
    if (offTopic.length)
      issues.push(`hypotheses ${offTopic.join(", ")} are not about the reported ${cov.uncovered.join("/")} symptom; describe other incidents in otherActiveIssues instead`);
  }
  // Impact's start time must match the metric onset (customer reports lag it).
  const start = state.impact.match(/\b(?:from|since|starting|started|starts|began|begins|beginning|onset)\b[^.]{0,25}?\b(\d{1,2}:\d{2})\b/i)?.[1];
  if (start && onset && Math.abs(minutesOf(start) - minutesOf(onset.slice(11, 16))) > 5)
    issues.push(`impact gives the start as ${start}, but the metrics changed at ${onset.slice(11, 16)} UTC (use the metric onset)`);
  const lead = state.hypotheses.find((h) => h.status !== "rejected");
  const confirmed = state.hypotheses.some((h) => h.status === "confirmed");
  const texts: [string, string][] = [
    ["summary", state.summary],
    ["impact", state.impact],
    ["stakeholder update", state.stakeholderUpdate],
  ];
  for (const [where, text] of texts) {
    if (!text) continue;
    if (confirmed && /\b(not (yet )?(been )?(human[- ])?confirmed|unconfirmed|awaiting (human )?confirmation|pending confirmation)\b/i.test(text))
      issues.push(`${where} says the cause is unconfirmed, but ${state.hypotheses.find((h) => h.status === "confirmed")!.id} is confirmed`);
    if (!confirmed && /\b(has been|have been|was|were|is) confirmed\b|\bconfirmed (the )?(root )?cause\b|\bwe (have )?confirmed\b/i.test(text))
      issues.push(`${where} claims confirmation, but no hypothesis is human-confirmed`);
  }
  for (const h of state.hypotheses.filter((x) => x.status === "rejected")) {
    // A rejected hypothesis named as the cause in the summary, e.g. "caused by DEP-102" when DEP-102's hypothesis is rejected.
    const own = h.supporting.filter((id) => !(lead?.supporting.includes(id) ?? false));
    for (const id of own)
      if (new RegExp(`(caused by|due to|because of|root cause[^.]*?)\\s*\\(?${id.replace(/[.]/g, "\\.")}\\b`, "i").test(state.summary))
        issues.push(`summary attributes the cause to ${id}, but ${h.id} (which it supports) is rejected`);
  }
  return issues;
}

/** One-line description of a piece of evidence; metrics describe their change, not the series. */
export function describeEvidence(id: string, pa: PreAnalysis, store: EvidenceStore): string {
  if (id.startsWith("MET-")) {
    // The chip already names the series; the note says what it did ("Rose 78 -> 290 (peak 323)").
    const t = pa.timeline.find((x) => x.evidenceId === id && x.kind === "changepoint")?.title;
    if (!t) return store.get(id)?.title ?? id;
    const rest = t.replace(`${id.slice(4)} `, "");
    return rest[0].toUpperCase() + rest.slice(1);
  }
  return store.get(id)?.title ?? id;
}

/** "13:52 inventory pool 20->80" -> "inventory pool 20->80": the time column already shows it. */
export const stripLeadingTime = (note: string) => {
  const out = note.replace(/^\s*\(?\d{1,2}:\d{2}(:\d{2})?\s*(utc|z)?\)?\s*(onwards?\b)?\s*[-–—:,]?\s*/i, "");
  if (out === note || !out) return note; // nothing stripped: leave identifiers like "payments.p95_latency_ms" alone
  return out[0].toUpperCase() + out.slice(1);
};

/**
 * The timeline is every event the brief relies on, not just the ones the model
 * listed: agent entries (their notes kept), everything cited by hypotheses, key
 * signals, summary and impact, every human follow-up, and the deploys/config
 * changes in the window before onset (so a red-herring deploy is always shown).
 * Evidence only a rejected hypothesis relies on is tagged "ruled-out".
 */
export function buildBriefTimeline(state: InvestigationState, pa: PreAnalysis, store: EvidenceStore): TimelineEntry[] {
  const live = state.hypotheses.filter((h) => h.status !== "rejected");
  const rejected = state.hypotheses.filter((h) => h.status === "rejected");
  const liveCited = new Set([
    ...live.flatMap((h) => [...h.supporting, ...h.contradicting, ...citedIn(h.statement), ...citedIn(h.reasoning)]),
    ...state.keySignals.flatMap((k) => [k.evidenceId, ...citedIn(k.why)]),
    ...citedIn(state.summary),
    ...citedIn(state.impact),
    ...state.timeline.map((t) => t.evidenceId),
  ]);
  const rejectedCited = new Set(rejected.flatMap((h) => [...h.supporting, ...h.contradicting]));
  // "Ruled out" = a rejected hypothesis rested on it and no live one lists it as evidence
  // (live reasoning often names the red herring only to dismiss it).
  const liveEvidence = new Set([...live.flatMap((h) => [...h.supporting, ...h.contradicting]), ...state.keySignals.map((k) => k.evidenceId)]);
  const rejectedSupport = new Set(rejected.flatMap((h) => h.supporting));
  const inWindow = pa.changes.filter((c) => c.relation === "before_onset_in_window").map((c) => c.id);
  const classes = followUpClasses(store);
  const followUps = store
    .list()
    .filter((e) => e.kind === "user" && classes.get(e.id)?.kind !== "instruction")
    .map((e) => e.id);

  const notes = new Map<string, string>();
  for (const t of state.timeline) if (t.source !== "code") notes.set(t.evidenceId, stripLeadingTime(t.note));
  for (const k of state.keySignals) if (k.source !== "code" && !notes.has(k.evidenceId)) notes.set(k.evidenceId, k.why);

  const ignored = new Set([...classes].filter(([, c]) => c.kind === "instruction").map(([id]) => id));
  const ids = [...new Set([...liveCited, ...rejectedCited, ...inWindow, ...followUps])].filter((id) => !ignored.has(id));
  const entries: TimelineEntry[] = [];
  for (const id of ids) {
    const ts = eventTime(id, pa, store);
    if (!ts) continue; // runbooks, write-ups: not events
    const e = store.get(id);
    const kind: TimelineEntry["kind"] = id.startsWith("USER-") ? "follow-up" : rejectedSupport.has(id) && !liveEvidence.has(id) ? "ruled-out" : "event";
    let note = notes.get(id) ?? describeEvidence(id, pa, store);
    const source = notes.has(id) && kind !== "follow-up" ? ("agent" as const) : ("code" as const);
    note =
      kind === "follow-up"
        ? `${classes.get(id)?.kind === "claim" ? "Follow-up (unverified claim)" : "Follow-up"}: ${cleanFollowUp(e?.title ?? note)}`
        : stripLeadingTime(note);
    entries.push({ ts, evidenceId: id, note, kind, source });
  }
  return entries.sort((a, b) => a.ts.localeCompare(b.ts) || a.evidenceId.localeCompare(b.evidenceId));
}

// Human report that service recovered after a fix ("connections back to 250", "error rate down to 0.3%", "restored").
const RECOVERY =
  /\b(recovered|recovery (is |was )?(complete|confirmed|verified|seen)|restored|back to (normal|baseline|healthy|\d)|returned to (normal|baseline|\d)|healthy again|(errors?|error rate|latency|connections)[^.;]{0,40}\b(back|down) to\b|errors? (have |has )?(cleared|stopped|gone))/i;
const NEGATED = /\b(not|no|never|hasn'?t|haven'?t|isn'?t|aren'?t|wasn'?t|didn'?t|still not|yet to|without)\b[^.;]{0,25}\b(recover|restor|back to|returned|healthy|clear|down to|stopped)/i;

/** USER- follow-ups that report recovery, judged from the human's own words (not left to the agent to tag). */
export function recoveryReports(store: EvidenceStore): string[] {
  const usable = evidenceFollowUps(store);
  return store
    .list()
    .filter((e) => e.kind === "user" && usable.has(e.id))
    .filter((e) => {
      const text = String((e.raw as { text?: string })?.text ?? e.title);
      return RECOVERY.test(text) && !NEGATED.test(text);
    })
    .map((e) => e.id);
}

/** Attach detected recovery reports to the confirmed leading hypothesis (alongside any the agent cited). */
export function attachRecovery<T extends { status: string; recoveryEvidence?: string[] }>(hypotheses: T[], reports: string[]): T[] {
  if (!reports.length) return hypotheses;
  const leadIdx = hypotheses.findIndex((h) => h.status !== "rejected");
  if (leadIdx < 0 || hypotheses[leadIdx].status !== "confirmed") return hypotheses;
  return hypotheses.map((h, i) => (i === leadIdx ? { ...h, recoveryEvidence: [...new Set([...(h.recoveryEvidence ?? []), ...reports])] } : h));
}

const RESOLVED = /\bresolv(ed|e the incident)\b|\bstable for (\d+|thirty|an?)\s*(min|minutes|hours?)\b|\bclos(ed|ing) the incident\b/i;

/**
 * Lifecycle from human evidence only: identified (cause confirmed), mitigated
 * (recovery after the fix reported), resolved (a later report says it held).
 */
export function incidentStatus(state: InvestigationState, store: EvidenceStore): NonNullable<InvestigationState["incidentStatus"]> {
  if (state.resolution) return "resolved"; // a responder resolved it (the Resolve action)
  if (state.coverage?.verdict === "none") return "insufficient-evidence";
  const lead = state.hypotheses.find((h) => h.status !== "rejected");
  if (!lead || lead.status !== "confirmed") return "investigating";
  const recovery = (lead.recoveryEvidence ?? []).filter((id) => id.startsWith("USER-"));
  if (!recovery.length) return "identified";
  const recoveredAt = recovery.map((id) => store.get(id)?.timestamp ?? "").sort()[0];
  const usable = evidenceFollowUps(store);
  const resolvedReport = store
    .list()
    .filter((e) => e.kind === "user" && usable.has(e.id) && (e.timestamp ?? "") >= recoveredAt)
    // Resolve/reopen action comments are handled explicitly; reports from before a reopen no longer count.
    .filter((e) => !["resolve", "reopen"].includes(String((e.raw as { action?: string })?.action)) && (!state.reopenedAt || (e.timestamp ?? "") > state.reopenedAt))
    .some((e) => RESOLVED.test(String((e.raw as { text?: string })?.text ?? e.title)));
  return resolvedReport ? "resolved" : "mitigated";
}

/** Closing steps once recovery is verified: watch it hold, then resolve; and learn from it. */
function closingActions(state: InvestigationState, status: InvestigationState["incidentStatus"], repeat?: RepeatIncident): NextAction[] {
  if (status !== "mitigated" && status !== "resolved") return [];
  const lead = state.hypotheses.find((h) => h.status !== "rejected")!;
  const recovery = (lead.recoveryEvidence ?? []).filter((id) => id.startsWith("USER-"));
  const out: NextAction[] = [];
  if (status === "mitigated")
    out.push({
      action: "Monitor error rate, latency and the affected resource for 30 minutes; if stable, resolve the incident",
      owner: "incident commander",
      type: "investigate",
      risk: "low",
      riskReason: "rubric: investigate = low",
      phase: "now",
      evidence: recovery,
      source: "code",
    });
  out.push({
    action: "Schedule the postmortem and assign owners to its action items",
    owner: "incident commander",
    type: "prevention",
    risk: "low",
    riskReason: "not risk-rated: planned post-incident work",
    phase: "prevention",
    priority: "P1",
    evidence: [...recovery, ...(repeat ? [repeat.incidentId] : [])],
    source: "code",
  });
  return out;
}

const IRREGULAR_PAST: Record<string, string[]> = {
  roll: ["rolled"],
  rollback: ["rolled back", "rollbacked"],
  set: ["set"],
  run: ["ran"],
  page: ["paged"],
  file: ["filed"],
  re: [],
};

/** Past-tense forms of an action's leading verb ("Revert ..." -> reverted). */
function pastForms(action: string): string[] {
  const m = action.trim().toLowerCase().match(/^(re-[a-z]+|[a-z]+)(\s+back)?\b/);
  if (!m) return [];
  const verb = m[1];
  if (/^(monitor|watch|check|verify|confirm|ask|decide|investigate|review|query)$/.test(verb)) return []; // ongoing, not one-off
  const regular = verb.endsWith("e") ? `${verb}d` : verb.endsWith("y") ? `${verb.slice(0, -1)}ied` : `${verb}ed`;
  const forms = [regular, ...(IRREGULAR_PAST[verb] ?? [])];
  return m[2] ? forms.map((f) => `${f} back`) : forms;
}

/** Specific things an action names (identifiers, versions, numbers, hyphenated service names). */
function specificTokens(action: string): string[] {
  return (action.match(/[A-Za-z0-9_.-]+/g) ?? []).filter(
    (t) => !/^(CFG|DEP|LOG|ALR|CHAT|CUST|USER|INC)-\d+$/.test(t) && (/_/.test(t) || /[A-Z]{2,}/.test(t) || (t.includes("-") && t.length >= 6) || /^v?\d+(\.\d+)+$/.test(t)),
  );
}

/**
 * Human follow-ups that report an action as already done: the follow-up uses
 * the action's verb in the past tense ("reverted") and names the same specific
 * thing (e.g. DB_POOL_MAX). Returns the USER- evidence IDs that satisfy it.
 */
export function satisfiedBy(action: string, followUps: { id: string; text: string }[]): string[] {
  const forms = pastForms(action);
  const specifics = specificTokens(action).map((t) => t.toLowerCase());
  if (!forms.length || !specifics.length) return [];
  return followUps
    .filter((f) => {
      const t = f.text.toLowerCase();
      return forms.some((p) => new RegExp(`\\b${p.replace(/ /g, "\\s+")}\\b`).test(t)) && specifics.some((x) => t.includes(x));
    })
    .map((f) => f.id);
}

/** Confidence ceiling while nothing in the data covers the reported symptom. */
export const MAX_UNCOVERED_CONFIDENCE = 0.3;

/** Active incidents in the data (the paged incident, else critical alerts), labelled with an unknown relationship. */
function otherIncidents(state: InvestigationState, store: EvidenceStore): NonNullable<InvestigationState["otherActiveIssues"]> {
  const about = state.coverage?.uncovered.length ? state.coverage.uncovered.join("/") : "the report";
  const paged = store.alerts.filter((a) => /\bINC-\d+\b/.test(a.title) && a.status !== "resolved");
  if (paged.length)
    return paged.map((a) => ({
      title: a.title.replace(/\s+opened:\s*/, ": "),
      evidence: [a.id],
      relationship: `relationship to ${about} unknown`,
      source: "code" as const,
    }));
  const critical = store.alerts.filter((a) => a.severity === "critical" && a.status !== "resolved");
  return critical.length
    ? [{ title: `Critical alerts on ${[...new Set(critical.map((a) => a.service))].join(", ")}`, evidence: critical.map((a) => a.id).slice(0, 6), relationship: `relationship to ${about} unknown`, source: "code" as const }]
    : [];
}

/** Change records that show an action already happened, e.g. "Roll back payments v2.14.0" -> DEP-103 (rollback). */
export function completedBy(action: string, store: EvidenceStore): string[] {
  const a = action.toLowerCase();
  if (!/^(roll ?back|revert)\b/.test(a)) return [];
  return store.deploys
    .filter((d) => d.type === "rollback" && a.includes(d.service.replace(/-service$/, "")))
    .filter((d) => {
      // If the action names a version, it must be the one rolled back from (or to).
      const v = a.match(/v\d+(\.\d+)+/)?.[0];
      return !v || d.version === v || d.summary.toLowerCase().includes(v);
    })
    .map((d) => d.id);
}

const PHASE_ORDER = { now: 0, after_recovery: 1, prevention: 2 } as const;

/** Recompute everything code derives from the brief. Called after every accepted update and at finalize. */
export function refreshDerived(state: InvestigationState, pa: PreAnalysis, store: EvidenceStore) {
  // Coverage of the report, refreshed with any follow-up evidence a human pasted.
  // Follow-ups: instructions are ignored and claims are not evidence (classified in code).
  const classes = followUpClasses(store);
  const notEvidence = new Set([...classes].filter(([, c]) => c.kind !== "evidence").map(([id]) => id));
  state.ignoredFollowUps = [...classes]
    .filter(([, c]) => c.kind === "instruction")
    .map(([id, c]) => ({ evidenceId: id, text: cleanFollowUp(c.text), reason: c.reason }));
  const keep = (ids: string[]) => ids.filter((id) => !notEvidence.has(id));
  state.hypotheses = state.hypotheses.map((h) => ({
    ...h,
    supporting: keep(h.supporting),
    contradicting: keep(h.contradicting),
    recoveryEvidence: h.recoveryEvidence ? keep(h.recoveryEvidence) : undefined,
  }));
  state.keySignals = state.keySignals.filter((k) => !notEvidence.has(k.evidenceId));
  for (const [id, c] of classes) {
    if (c.kind !== "claim" || state.openQuestions.some((q) => q.includes(id))) continue;
    state.openQuestions = [...state.openQuestions, `Unverified claim (${id}): "${cleanFollowUp(c.text)}" What evidence supports it, and who can provide it?`];
  }

  if (state.incidentInput) state.coverage = checkCoverage(state.incidentInput, store, notEvidence);
  const insufficient = state.coverage?.verdict === "none";

  // Recovery is read from the human's report, not left to the agent to tag (it often cites it only as support).
  state.hypotheses = attachRecovery(state.hypotheses, recoveryReports(store));

  // Nothing in the data covers the reported symptom: no hypothesis may claim much about it.
  if (insufficient)
    state.hypotheses = state.hypotheses.map((h) => ({
      ...h,
      confidence: Math.min(h.confidence, MAX_UNCOVERED_CONFIDENCE),
      status: h.status === "confirmed" ? ("active" as const) : h.status,
    }));

  // Other incidents in the data are shown separately, never as the answer.
  const agentOther = (state.otherActiveIssues ?? []).filter((o) => o.source === "agent");
  state.otherActiveIssues = state.coverage && state.coverage.verdict !== "covered" ? (agentOther.length ? agentOther : otherIncidents(state, store)) : agentOther;

  // Key signals never go empty: if the agent wrote none, use the leading hypothesis's own evidence.
  const lead = state.hypotheses.find((h) => h.status !== "rejected");
  const agentSignals = state.keySignals.filter((k) => k.source !== "code");
  state.keySignals = agentSignals.length
    ? agentSignals
    : (lead?.supporting ?? []).slice(0, 6).map((id) => ({ evidenceId: id, why: describeEvidence(id, pa, store), source: "code" as const }));

  // Timeline: every event the brief relies on, times from the evidence (never the model).
  state.timeline = buildBriefTimeline(state, pa, store);

  // Noise: the heuristics' flags are always included and shown; the agent may add items, give its own
  // reason (kept alongside the flags), or keep a flagged alert as signal (notNoise, with a reason).
  const flagsById = new Map(pa.alerts.filter((a) => a.likelyNoise).map((a) => [a.id, a.flags.map((f) => f.replace(/_/g, " "))]));
  const overridden = new Set((state.notNoise ?? []).map((n) => n.evidenceId));
  const agentNoise = state.noise.filter((n) => n.source !== "code" && !overridden.has(n.evidenceId));
  const codeNoise = [...flagsById.keys()]
    .filter((id) => !overridden.has(id) && !agentNoise.some((n) => n.evidenceId === id))
    .map((id) => ({ evidenceId: id, why: "", source: "code" as const }));
  // Reason shown once: the agent's reason if it gave one, otherwise just the heuristic flags.
  state.noise = [...agentNoise.map((n) => ({ ...n, source: "agent" as const })), ...codeNoise].map((n) => ({
    ...n,
    flags: flagsById.get(n.evidenceId),
    why: n.source === "agent" ? n.why : "",
  }));

  state.similarIncidents = similarIncidents(state, store);
  const repeat = repeatIncident(state, store);
  state.repeatIncident = repeat;

  const agentFactors = (state.contributingFactors ?? []).filter((f) => f.source === "agent");
  // Code-derived factors (with their INC-2041-style citations) are always shown; an agent factor saying the same is dropped.
  const codeFactors = derivedFactors(state, pa, store, repeat);
  state.contributingFactors = [...agentFactors.filter((a) => !codeFactors.some((f) => overlaps(a.factor, f.factor, 0.4))), ...codeFactors];

  // Prevention: closing a repeat incident's open action items stops this exact failure recurring, so P1.
  const agentActions = state.nextActions
    .filter((a) => a.source !== "code")
    .map((a) =>
      a.phase === "prevention" && repeat?.openActionItems.some((item) => coversItem(a.action, item))
        ? { ...a, priority: "P1" as const, evidence: a.evidence.includes(repeat.incidentId) ? a.evidence : [repeat.incidentId, ...a.evidence] }
        : a,
    );
  const covered = (repeat?.openActionItems ?? []).filter((item) => agentActions.some((a) => a.phase === "prevention" && coversItem(a.action, item)));
  const status = incidentStatus(state, store);
  state.incidentStatus = status;
  // With no evidence for the report, the first thing to do is get some.
  const gather: NextAction[] =
    status === "insufficient-evidence" && state.coverage
      ? [...new Set(state.coverage.uncovered.map((t) => whatToProvide(t)))].map((need) => ({
          action: `Collect ${need}, from the owners of ${state.coverage!.uncovered.join("/")}, and add it as a follow-up`,
          type: "investigate" as const,
          risk: "low" as const,
          riskReason: "rubric: investigate = low",
          phase: "now" as const,
          evidence: [],
          source: "code" as const,
        }))
      : [];
  const codeActions: NextAction[] = [
    ...gather,
    ...preventionActions(repeat)
      .filter((c) => !covered.some((item) => c.action.endsWith(item)))
      .map((c) => ({ ...c, risk: "low" as const, riskReason: "not risk-rated: planned post-incident work", priority: "P1" as const })),
    // Unless the agent already has them.
    ...closingActions(state, status, repeat).filter((c) =>
      /postmortem/i.test(c.action)
        ? !agentActions.some((a) => /post-?mortem|retro(spective)?|incident review/i.test(a.action))
        : !agentActions.some((a) => /\b(monitor|watch)\b/i.test(a.action) && /\bresolv/i.test(a.action)),
    ),
  ];
  // Actions a human follow-up reports as done move to Done, citing that follow-up.
  const usable = evidenceFollowUps(store);
  const followUps = store
    .list()
    .filter((e) => e.kind === "user" && usable.has(e.id))
    .map((e) => ({ id: e.id, text: String((e.raw as { text?: string })?.text ?? e.title) }));
  // Done items cite what completed them: a system record if there is one, not the follow-up that mentioned it.
  const done = (state.doneActions ?? []).map((d) => {
    const records = d.evidence.filter((id) => !id.startsWith("USER-"));
    const proof = records.length ? records : completedBy(d.action, store);
    return { ...d, evidence: proof.length ? proof : d.evidence.filter((id) => usable.has(id)) };
  });
  // Data-gathering for an uncovered report goes first, so it is the "Do now" step.
  const remaining = [...gather, ...agentActions, ...codeActions.filter((c) => !gather.includes(c))].filter((a) => {
    if (done.some((d) => overlaps(d.action, a.action, 0.6))) return false; // already listed as done (e.g. by the agent)
    const records = completedBy(a.action, store);
    const by = records.length ? records : satisfiedBy(a.action, followUps);
    if (!by.length) return true;
    done.push({ action: a.action, evidence: by, source: "code" });
    return false;
  });
  state.doneActions = done;
  state.nextActions = remaining.sort(
    (x, y) => PHASE_ORDER[x.phase] - PHASE_ORDER[y.phase] || (x.priority ?? "P9").localeCompare(y.priority ?? "P9"),
  );

  // One risk rule for every action, including ones saved before the rubric changed.
  state.nextActions = state.nextActions.map((a) => (a.phase === "prevention" ? a : { ...a, ...assessRisk(a.type, a.action) }));

  state.unexplained = unexplainedSignals(state, pa, store);
  state.consistencyIssues = consistencyIssues(state, pa.onset, notEvidence);
  // One rule for confidence: the brief's overall confidence is the leading hypothesis's.
  state.overallConfidence = state.hypotheses.find((h) => h.status !== "rejected")?.confidence ?? 0;
}
