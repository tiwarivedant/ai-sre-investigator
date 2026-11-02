import type { InvestigationUpdate } from "./schemas";

/**
 * Grounding guard. Every evidence ID the agent cites, in structured fields or
 * inline in prose, must exist in the evidence store. The first time an update
 * cites unknown IDs it is rejected so the agent can correct itself; if it
 * happens again in the same run, the bad citations are stripped and recorded
 * instead of blocking progress.
 */

// IDs as they appear in prose. INC- is excluded from the prose scan because
// the current incident's own number (e.g. INC-2213) is legitimately mentioned
// but is not a citable record; past incidents are still checked in structured fields.
const PROSE_ID = /\b(?:ALR|LOG|DEP|CFG|CHAT|CUST|USER)-\d+\b|\bRB-[a-z0-9-]+\b|\bMET-[a-z0-9_]+\.[a-z0-9_]+\b/g;

export interface GroundingReport {
  unknownIds: string[];
  /** Where each unknown ID was cited, for the error message. */
  locations: string[];
}

export function checkGrounding(update: InvestigationUpdate, exists: (id: string) => boolean): GroundingReport {
  const unknown = new Set<string>();
  const locations: string[] = [];
  const check = (id: string, where: string) => {
    if (!exists(id)) {
      unknown.add(id);
      locations.push(`${where}: ${id}`);
    }
  };
  const scanProse = (text: string | undefined, where: string) => {
    for (const id of text?.match(PROSE_ID) ?? []) check(id, where);
  };

  scanProse(update.summary, "summary");
  scanProse(update.impact, "impact");
  update.timeline?.forEach((t, i) => {
    check(t.evidenceId, `timeline[${i}]`);
    scanProse(t.note, `timeline[${i}].note`);
  });
  update.keySignals?.forEach((s, i) => check(s.evidenceId, `keySignals[${i}]`));
  update.noise?.forEach((s, i) => check(s.evidenceId, `noise[${i}]`));
  update.notNoise?.forEach((s, i) => check(s.evidenceId, `notNoise[${i}]`));
  update.hypotheses?.forEach((h) => {
    h.supporting.forEach((id) => check(id, `${h.id}.supporting`));
    h.contradicting.forEach((id) => check(id, `${h.id}.contradicting`));
    scanProse(h.statement, `${h.id}.statement`);
    scanProse(h.reasoning, `${h.id}.reasoning`);
  });
  update.nextActions?.forEach((a, i) => a.evidence.forEach((id) => check(id, `nextActions[${i}]`)));
  update.similarIncidents?.forEach((x, i) => check(x.incidentId, `similarIncidents[${i}]`));
  update.contributingFactors?.forEach((f, i) => f.evidence.forEach((id) => check(id, `contributingFactors[${i}]`)));
  update.hypotheses?.forEach((h) => h.recoveryEvidence?.forEach((id) => check(id, `${h.id}.recoveryEvidence`)));

  return { unknownIds: [...unknown], locations };
}

/** Remove citations of unknown IDs. Entries that only existed to cite a bad ID are dropped. */
export function stripUnknown(update: InvestigationUpdate, exists: (id: string) => boolean): InvestigationUpdate {
  const keep = (ids: string[]) => ids.filter(exists);
  const scrub = (text: string) => text.replace(PROSE_ID, (id) => (exists(id) ? id : "[unverified citation removed]"));
  const out: InvestigationUpdate = { ...update };
  if (out.summary) out.summary = scrub(out.summary);
  if (out.impact) out.impact = scrub(out.impact);
  if (out.timeline) out.timeline = out.timeline.filter((t) => exists(t.evidenceId)).map((t) => ({ ...t, note: scrub(t.note) }));
  if (out.keySignals) out.keySignals = out.keySignals.filter((s) => exists(s.evidenceId));
  if (out.noise) out.noise = out.noise.filter((s) => exists(s.evidenceId));
  if (out.notNoise) out.notNoise = out.notNoise.filter((s) => exists(s.evidenceId));
  if (out.nextActions) out.nextActions = out.nextActions.map((a) => ({ ...a, evidence: keep(a.evidence) }));
  if (out.similarIncidents) out.similarIncidents = out.similarIncidents.filter((x) => exists(x.incidentId));
  if (out.contributingFactors)
    out.contributingFactors = out.contributingFactors.map((f) => ({ ...f, evidence: keep(f.evidence) })).filter((f) => f.evidence.length > 0);
  if (out.hypotheses) {
    out.hypotheses = out.hypotheses
      .map((h) => ({
        ...h,
        statement: scrub(h.statement),
        reasoning: scrub(h.reasoning),
        supporting: keep(h.supporting),
        contradicting: keep(h.contradicting),
        recoveryEvidence: h.recoveryEvidence ? keep(h.recoveryEvidence) : undefined,
      }))
      // A hypothesis with no remaining support is an ungrounded claim.
      .filter((h) => h.supporting.length > 0);
  }
  return out;
}
