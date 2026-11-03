import { whatToProvide } from "@/lib/analysis/coverage";
import { revisionLabel } from "@/lib/text";
import type { InvestigationState } from "@/lib/types";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const ids = (xs: string[]) => (xs.length ? xs.map((x) => `\`${x}\``).join(" ") : "none");

/** Render the brief as Markdown (CLI output, export button, samples/). */
export function briefToMarkdown(s: InvestigationState): string {
  const out: string[] = [];
  out.push(`# Investigation brief`);
  out.push(
    `_${s.id} · run: **${s.status}**${s.statusReason ? ` (${s.statusReason})` : ""}${s.incidentStatus ? ` · incident: **${s.incidentStatus}**` : ""} · updated ${s.updatedAt}_`,
  );
  out.push(`\n> ${s.incidentInput.replace(/\n/g, "\n> ")}`);

  if (s.coverage && s.coverage.verdict !== "covered") {
    out.push(`\n## Answer\n${s.coverage.verdict === "none" ? "No evidence" : "Partial evidence: nothing"} about **${s.coverage.uncovered.join(", ")}** in the available data (searched ${s.coverage.searched.join(", ")}).`);
    for (const need of new Set(s.coverage.uncovered.map((t) => whatToProvide(t)))) out.push(`- To investigate, provide ${need}.`);
  }
  for (const o of s.otherActiveIssues ?? []) out.push(`\n> **Other active incident:** ${o.title} (${ids(o.evidence)}); ${o.relationship.replace(/[.\s]+$/, "")}.`);
  if (s.untestedSuspects?.length) out.push(`\n> **Untested suspects:** ${s.untestedSuspects.join(", ")} (no hypothesis supports or rules them out).`);
  if (s.consistencyIssues?.length) out.push(`\n> **Check this brief:** ${s.consistencyIssues.join("; ")}.`);
  for (const f of s.ignoredFollowUps ?? []) out.push(`\n> **Ignored follow-up** \`${f.evidenceId}\`: instruction-like text, not treated as evidence ("${f.text}").`);
  if (s.briefSource === "pre-analysis") {
    out.push(`\n> **Pre-analysis only.** The agent did not finish; this lists what code measured. No root cause has been judged and no actions are recommended.`);
  }
  out.push(`\n## Summary\n${s.summary || "_not yet written_"}`);
  if (s.briefSource !== "pre-analysis") out.push(`\n**Overall confidence:** ${pct(s.overallConfidence)}`);
  out.push(`\n## Impact\n${s.impact || "_not yet written_"}`);

  if (s.hypotheses.length) out.push(`\n## Hypotheses`);
  for (const h of s.hypotheses) {
    out.push(`\n### ${h.id} · ${h.status.toUpperCase()} · ${pct(h.confidence)}\n${h.statement}`);
    out.push(`\n- Supporting: ${ids(h.supporting)}\n- Contradicting: ${ids(h.contradicting)}\n- Reasoning: ${h.reasoning}`);
  }

  if (s.unexplained?.length) {
    out.push(`\n**Not yet explained** (anomalies no hypothesis, signal or noise entry accounts for):`);
    for (const u of s.unexplained) {
      out.push(`- \`${u.evidenceId}\` ${u.what}`);
      for (const r of u.related) out.push(`  - possibly related: \`${r.evidenceId}\` ${r.why}`);
    }
  }

  if (s.repeatIncident) {
    out.push(`\n> **Repeat incident.** \`${s.repeatIncident.incidentId}\` had the same failure, and its action items are still open:`);
    for (const item of s.repeatIncident.openActionItems) out.push(`> - [ ] ${item}`);
  }

  if (s.similarIncidents?.length) {
    out.push(`\n## Similar past incidents`);
    for (const x of s.similarIncidents)
      out.push(`- \`${x.incidentId}\` ${x.similarity}${x.source === "retrieval" ? " _(matched by retrieval)_" : ""}${x.lesson ? `\n  - Lesson: ${x.lesson}` : ""}`);
  }

  if (s.contributingFactors?.length) {
    out.push(`\n## Contributing factors`);
    for (const f of s.contributingFactors) out.push(`- ${f.factor} · evidence: ${ids(f.evidence)}${f.source === "code" ? " _(derived from data)_" : ""}`);
  }

  if (s.timeline.length) {
    out.push(`\n## Timeline (UTC)`);
    for (const t of s.timeline)
      out.push(`- **${t.kind === "follow-up" || t.evidenceId.startsWith("USER-") ? "follow-up" : t.ts.slice(11, 16)}** \`${t.evidenceId}\` ${t.note}${t.kind === "ruled-out" ? " _(ruled out)_" : ""}`);
  }

  if (s.keySignals.length) {
    out.push(`\n## Key signals`);
    for (const k of s.keySignals) out.push(`- \`${k.evidenceId}\` ${k.why}`);
  }
  if (s.noise.length) {
    out.push(`\n## Noise (ruled out)`);
    // Reason once: the agent's reason (tagged heuristic if code also flags it), or just the flags.
    for (const k of s.noise)
      out.push(`- \`${k.evidenceId}\` ${k.why ? `${k.why}${k.flags ? " _(heuristic)_" : ""}` : `_heuristic: ${(k.flags ?? []).join(", ")}_`}`);
    for (const k of s.notNoise ?? []) out.push(`- kept as signal: \`${k.evidenceId}\` ${k.why}`);
  }

  const renderActions = (title: string, actions: InvestigationState["nextActions"]) => {
    if (!actions.length) return;
    out.push(`\n## ${title}`);
    actions.forEach((a, i) =>
      out.push(
        a.phase === "prevention"
          ? `${i + 1}. **[${a.priority ?? "P2"}]** ${a.action}${a.owner ? ` (owner: ${a.owner})` : ""} · evidence: ${ids(a.evidence)}`
          : `${i + 1}. **[${a.risk} risk]** ${a.action}${a.owner ? ` (owner: ${a.owner})` : ""} · evidence: ${ids(a.evidence)} · _${a.riskReason}_`,
      ),
    );
  };
  renderActions("Next actions", s.nextActions.filter((a) => a.phase === "now"));
  renderActions("After recovery is verified", s.nextActions.filter((a) => a.phase === "after_recovery"));
  renderActions("Prevent recurrence (post-incident)", s.nextActions.filter((a) => a.phase === "prevention"));
  if (s.doneActions?.length) {
    out.push(`\n## Done`);
    for (const d of s.doneActions) out.push(`- [x] ${d.action} · per ${ids(d.evidence)}`);
  }

  if (s.openQuestions.length) {
    out.push(`\n## Open questions`);
    for (const q of s.openQuestions) out.push(`- ${q}`);
  }

  out.push(`\n## Stakeholder update\n${s.stakeholderUpdate || "_not yet written_"}`);

  if (s.revisions.length) {
    out.push(`\n## Revisions`);
    for (const r of s.revisions) out.push(`- ${r.at} (${revisionLabel(r.trigger)}): ${r.changes.join("; ")}`);
  }
  if (s.groundingIssues.length) {
    out.push(`\n## Grounding guard`);
    for (const g of s.groundingIssues) out.push(`- ${g}`);
  }
  return out.join("\n") + "\n";
}
