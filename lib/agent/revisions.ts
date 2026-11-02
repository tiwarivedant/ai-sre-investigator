import type { Hypothesis, InvestigationState, Revision } from "@/lib/types";

type Snapshot = Pick<InvestigationState, "hypotheses" | "overallConfidence" | "openQuestions" | "nextActions"> &
  Partial<Pick<InvestigationState, "incidentStatus">>;

export function snapshot(s: InvestigationState): Snapshot {
  return structuredClone({
    hypotheses: s.hypotheses,
    overallConfidence: s.overallConfidence,
    openQuestions: s.openQuestions,
    nextActions: s.nextActions,
    incidentStatus: s.incidentStatus,
  });
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Deterministic diff of what a follow-up changed, for the "What changed" banner. */
export function diffBriefs(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  if (before.incidentStatus && after.incidentStatus && before.incidentStatus !== after.incidentStatus)
    changes.push(`incident ${before.incidentStatus} -> ${after.incidentStatus}`);
  const prev = new Map<string, Hypothesis>(before.hypotheses.map((h) => [h.id, h]));
  const next = new Map<string, Hypothesis>(after.hypotheses.map((h) => [h.id, h]));

  for (const h of after.hypotheses) {
    const p = prev.get(h.id);
    if (!p) {
      changes.push(`${h.id} added (${h.status}, ${pct(h.confidence)}): ${h.statement}`);
      continue;
    }
    if (p.status !== h.status) changes.push(`${h.id} status ${p.status} -> ${h.status}`);
    if (Math.abs(p.confidence - h.confidence) >= 0.01) changes.push(`${h.id} confidence ${pct(p.confidence)} -> ${pct(h.confidence)}`);
    const newEvidence = h.supporting.filter((id) => !p.supporting.includes(id));
    if (newEvidence.length) changes.push(`${h.id} new supporting evidence: ${newEvidence.join(", ")}`);
  }
  for (const h of before.hypotheses) if (!next.has(h.id)) changes.push(`${h.id} removed`);

  if (Math.abs(before.overallConfidence - after.overallConfidence) >= 0.01)
    changes.push(`overall confidence ${pct(before.overallConfidence)} -> ${pct(after.overallConfidence)}`);

  const resolved = before.openQuestions.filter((q) => !after.openQuestions.includes(q)).length;
  const added = after.openQuestions.filter((q) => !before.openQuestions.includes(q)).length;
  if (resolved || added) changes.push(`open questions: ${resolved} resolved, ${added} new`);

  const beforeActions = new Set(before.nextActions.map((a) => a.action));
  const newActions = after.nextActions.filter((a) => !beforeActions.has(a.action)).length;
  if (newActions) changes.push(`${newActions} new next action${newActions > 1 ? "s" : ""}`);

  return changes;
}

export function makeRevision(trigger: string, before: Snapshot, after: Snapshot): Revision {
  const changes = diffBriefs(before, after);
  return { at: new Date().toISOString(), trigger, changes: changes.length ? changes : ["no change to hypotheses or confidence"] };
}
