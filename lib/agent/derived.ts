import type { EvidenceStore } from "@/lib/evidence/loader";
import type { PreAnalysis } from "@/lib/analysis/preAnalysis";
import { Bm25Index, tokenize } from "@/lib/retrieval/bm25";
import type { ContributingFactor, InvestigationState, NextAction, RepeatIncident, SimilarIncident } from "@/lib/types";

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

  return pa.changePoints
    .filter((c) => c.sustained && !cited.has(c.seriesId) && !coveredServices.has(c.service) && !named(c.service))
    .map((c) => ({
      evidenceId: c.seriesId,
      what: `${c.series} rose ${c.baseline} -> ${c.value} at ${c.ts.slice(11, 16)}${c.recoveredAt ? `, recovered ${c.recoveredAt.slice(11, 16)}` : ""}`,
      related: relatedEvidence(c.seriesId, pa, store),
    }));
}

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

/** Brief text that contradicts what the hypotheses say. */
export function consistencyIssues(state: InvestigationState): string[] {
  const issues: string[] = [];
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

const PHASE_ORDER = { now: 0, after_recovery: 1, prevention: 2 } as const;

/** Recompute everything code derives from the brief. Called after every accepted update and at finalize. */
export function refreshDerived(state: InvestigationState, pa: PreAnalysis, store: EvidenceStore) {
  // Timeline: times come from the evidence, never the model. Entries with no event time (runbooks, write-ups) are dropped.
  state.timeline = state.timeline
    .map((t) => ({ ...t, ts: eventTime(t.evidenceId, pa, store) ?? "" }))
    .filter((t) => t.ts)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.evidenceId.localeCompare(b.evidenceId));

  // Noise: the heuristics' flags are always included; the agent may add items, give a better reason,
  // or keep a flagged alert as signal (notNoise, with a reason).
  const overridden = new Set((state.notNoise ?? []).map((n) => n.evidenceId));
  const agentNoise = state.noise.filter((n) => n.source !== "code" && !overridden.has(n.evidenceId));
  const codeNoise = pa.alerts
    .filter((a) => a.likelyNoise && !overridden.has(a.id) && !agentNoise.some((n) => n.evidenceId === a.id))
    .map((a) => ({ evidenceId: a.id, why: `flagged by heuristics: ${a.flags.join(", ").replace(/_/g, " ")}`, source: "code" as const }));
  state.noise = [...agentNoise.map((n) => ({ ...n, source: "agent" as const })), ...codeNoise];

  state.similarIncidents = similarIncidents(state, store);
  const repeat = repeatIncident(state, store);
  state.repeatIncident = repeat;

  const agentFactors = (state.contributingFactors ?? []).filter((f) => f.source === "agent");
  state.contributingFactors = [
    ...agentFactors,
    ...derivedFactors(state, pa, store, repeat).filter((f) => !agentFactors.some((a) => overlaps(a.factor, f.factor))),
  ];

  // Prevention: closing a repeat incident's open action items stops this exact failure recurring, so P1.
  const agentActions = state.nextActions
    .filter((a) => a.source !== "code")
    .map((a) =>
      a.phase === "prevention" && repeat?.openActionItems.some((item) => coversItem(a.action, item)) ? { ...a, priority: "P1" as const } : a,
    );
  const covered = (repeat?.openActionItems ?? []).filter((item) => agentActions.some((a) => a.phase === "prevention" && coversItem(a.action, item)));
  const codeActions: NextAction[] = preventionActions(repeat)
    .filter((c) => !covered.some((item) => c.action.endsWith(item)))
    .map((c) => ({ ...c, risk: "low" as const, riskReason: "not risk-rated: planned post-incident work", priority: "P1" as const }));
  state.nextActions = [...agentActions, ...codeActions].sort(
    (x, y) => PHASE_ORDER[x.phase] - PHASE_ORDER[y.phase] || (x.priority ?? "P9").localeCompare(y.priority ?? "P9"),
  );

  state.unexplained = unexplainedSignals(state, pa, store);
  state.consistencyIssues = consistencyIssues(state);
}
