import { z } from "zod";
import { InvestigationUpdateSchema } from "@/lib/agent/schemas";
import { checkGrounding, stripUnknown } from "@/lib/agent/grounding";
import { applyPolicy, missingOpenQuestions } from "@/lib/agent/policy";
import { attachRecovery, recoveryReports, refreshDerived } from "@/lib/agent/derived";
import type { Hypothesis, InvestigationState, NextAction } from "@/lib/types";
import { defineTool, type ToolContext } from "./types";

const STATUS_RANK: Record<Hypothesis["status"], number> = { confirmed: 0, active: 1, rejected: 2 };

export const updateInvestigation = defineTool({
  name: "update_investigation",
  description:
    "Write your working investigation state. Send only the fields you are changing; each field you send REPLACES the previous value (send full lists). Every cited evidence ID is checked against the evidence store; updates citing unknown IDs are rejected. Code then applies calibration policy (confirmation and confidence caps, action risk, after-recovery phasing) and reports any adjustments. Call this early and refine as you learn.",
  schema: InvestigationUpdateSchema,
  run(update, ctx) {
    const exists = (id: string) => ctx.store.has(id);
    const report = checkGrounding(update, exists);
    if (report.unknownIds.length) {
      if (ctx.groundingRejections === 0) {
        ctx.groundingRejections++;
        return {
          result: {
            error: "Rejected: cites evidence IDs that do not exist. Fix or remove them and resend the update.",
            unknownIds: report.unknownIds,
            where: report.locations,
          },
          summary: `rejected by grounding guard: ${report.unknownIds.join(", ")}`,
          isError: true,
        };
      }
      update = stripUnknown(update, exists);
      ctx.state.groundingIssues.push(...report.locations.map((l) => `stripped unverified citation (${l})`));
    }

    if (update.hypotheses) update = { ...update, hypotheses: attachRecovery(update.hypotheses, recoveryReports(ctx.store)) };
    const policy = applyPolicy(update, ctx.pa.changes, ctx.state.hypotheses);
    applyUpdate(ctx.state, policy.update, policy.nextActions);
    refreshDerived(ctx.state, ctx.pa, ctx.store);
    const fields = Object.keys(update);
    if (update.summary) ctx.mustRewrite?.delete("summary");
    if (update.impact) ctx.mustRewrite?.delete("impact");
    const impactMissesCustomers = missesCustomerNotes(ctx);
    return {
      result: {
        ok: true,
        updated: fields,
        stripped: report.unknownIds.length ? report.unknownIds : undefined,
        policyAdjustments: policy.adjustments.length ? policy.adjustments : undefined,
        hypotheses: ctx.state.hypotheses.map((h) => `${h.id} ${h.status} ${h.confidence}`),
        nextActions: policy.nextActions?.map((a) => `[${a.phase}] [${a.risk} risk: ${a.riskReason}] ${a.action}`),
        similarIncidents: ctx.state.similarIncidents?.map((x) => `${x.incidentId} (${x.source}): ${x.similarity}`),
        unexplained: ctx.state.unexplained?.length
          ? {
              note: "These anomalies are not accounted for by any non-rejected hypothesis, key signal, or noise entry. Explain each (as a symptom, a contradiction, or noise) or say why it is irrelevant. Related evidence is listed to check, not as an explanation.",
              signals: ctx.state.unexplained.map((u) => ({ anomaly: `${u.evidenceId}: ${u.what}`, possiblyRelated: u.related.map((r) => `${r.evidenceId} (${r.why})`) })),
            }
          : undefined,
        repeatIncident: ctx.state.repeatIncident
          ? `${ctx.state.repeatIncident.incidentId} had the same failure; open action items: ${ctx.state.repeatIncident.openActionItems.join("; ")}`
          : undefined,
        contributingFactors: ctx.state.contributingFactors?.map((f) => `(${f.source}) ${f.factor}`),
        noise: `code-flagged noise is always included: ${ctx.state.noise.filter((n) => n.source === "code").map((n) => n.evidenceId).join(", ") || "none"}. Use notNoise (with a reason) to keep one as signal.`,
        consistencyIssues: ctx.state.consistencyIssues?.length ? ctx.state.consistencyIssues : undefined,
        impactHint: impactMissesCustomers
          ? `Impact cites no customer notes, but support notes exist: ${customerIds(ctx).join(", ")}. Add what customers experience (ticket volume, errors seen, payment/order integrity concerns), citing them.`
          : undefined,
        mustRewrite: ctx.mustRewrite?.size ? `Before finalize, rewrite: ${[...ctx.mustRewrite].join(", ")}` : undefined,
      },
      summary:
        `updated ${fields.join(", ")}` +
        `${report.unknownIds.length ? ` (stripped ${report.unknownIds.join(", ")})` : ""}` +
        `${policy.adjustments.length ? ` · policy: ${policy.adjustments.join("; ")}` : ""}`,
    };
  },
});

/** Merge a validated, policy-checked update. `nextActions` must be the policy-normalised list (with risk/phase). */
export function applyUpdate(state: InvestigationState, update: z.infer<typeof InvestigationUpdateSchema>, nextActions?: NextAction[]) {
  const {
    nextActions: _raw,
    similarIncidents: agentSimilar,
    contributingFactors: agentFactors,
    noise: agentNoise,
    keySignals: _ks,
    completedActions,
    ...rest
  } = update;
  Object.assign(state, rest);
  // Timeline entries arrive without times; refreshDerived fills them from the evidence.
  if (update.timeline) state.timeline = update.timeline.map((t) => ({ ...t, ts: "", source: "agent" as const }));
  if (agentNoise) {
    // Keep earlier agent reasons for items this update leaves out (code re-adds flagged ones anyway).
    const earlier = state.noise.filter((n) => n.source === "agent" && !agentNoise.some((a) => a.evidenceId === n.evidenceId));
    state.noise = [...agentNoise.map((n) => ({ ...n, source: "agent" as const })), ...earlier];
  }
  // An empty key-signals list is "no change", not "clear them".
  if (update.keySignals) state.keySignals = update.keySignals.length ? update.keySignals.map((k) => ({ ...k, source: "agent" as const })) : state.keySignals;
  if (agentSimilar) state.similarIncidents = agentSimilar.map((x) => ({ ...x, source: "agent" as const }));
  if (agentFactors) state.contributingFactors = agentFactors.map((f) => ({ ...f, source: "agent" as const }));
  if (completedActions?.length) {
    const done = state.doneActions ?? [];
    for (const c of completedActions) if (!done.some((d) => d.action === c.action)) done.push({ ...c, source: "agent" });
    state.doneActions = done;
  }
  // Agent-sent actions replace the agent's previous ones; code-derived ones are re-added by refreshDerived.
  if (nextActions) state.nextActions = [...nextActions.map((a) => ({ ...a, source: "agent" as const })), ...state.nextActions.filter((a) => a.source === "code")];
  state.briefSource = "agent";
  // Deterministic ranking: confirmed, then active, then rejected; each by confidence.
  state.hypotheses = [...state.hypotheses].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.confidence - a.confidence,
  );
  // Timeline times and order are derived from the evidence in refreshDerived.
  state.updatedAt = new Date().toISOString();
}

export const finalize = defineTool({
  name: "finalize",
  description:
    "Finish the investigation once the brief is complete. Rejected with a list of missing pieces if the brief is incomplete.",
  schema: z.object({
    rationale: z.string().describe("One sentence: why the evidence is sufficient to stop here (or why it can't get better)."),
  }),
  run({ rationale }, ctx) {
    const s = ctx.state;
    const missing: string[] = [];
    if (!s.summary) missing.push("summary");
    if (!s.impact) missing.push("impact");
    if (s.hypotheses.length === 0) missing.push("hypotheses");
    if (s.nextActions.length === 0) missing.push("nextActions");
    if (!s.stakeholderUpdate) missing.push("stakeholderUpdate");
    if (s.timeline.length === 0) missing.push("timeline");
    if (missingOpenQuestions(s)) missing.push("openQuestions (nothing is human-confirmed, so say what is still unknown and who can answer it)");
    for (const f of ctx.mustRewrite ?? []) missing.push(`${f} (rewrite it for the new information; the current text predates the follow-up)`);
    if (missing.length) {
      return {
        result: { error: `Brief incomplete. Call update_investigation with: ${missing.join(", ")}. Then finalize again.` },
        summary: `finalize rejected: missing ${missing.join(", ")}`,
        isError: true,
      };
    }
    // Derived parts (timeline times, similar incidents, repeat detection, noise) are recomputed at the end.
    refreshDerived(s, ctx.pa, ctx.store);
    if (missesCustomerNotes(ctx) && !ctx.impactWarned) {
      ctx.impactWarned = true;
      return {
        result: { error: `Impact ignores the customer notes from support (${customerIds(ctx).join(", ")}). Read them (get_evidence) and add the customer-facing impact, then finalize again.` },
        summary: "finalize rejected: impact cites none of the customer notes",
        isError: true,
      };
    }
    if (s.consistencyIssues?.length && !ctx.consistencyWarned) {
      ctx.consistencyWarned = true;
      return {
        result: { error: "The brief contradicts itself. Fix these with update_investigation, then finalize again.", issues: s.consistencyIssues },
        summary: `finalize rejected: ${s.consistencyIssues.join("; ")}`,
        isError: true,
      };
    }
    return { result: { ok: true }, summary: `finalized: ${rationale}`, done: true };
  },
});

export const stateTools = [updateInvestigation, finalize];

const customerIds = (ctx: ToolContext) =>
  ctx.store
    .list()
    .filter((e) => e.kind === "customer")
    .map((e) => e.id);

/** Customer notes exist but the Impact section cites none of them. */
function missesCustomerNotes(ctx: ToolContext): boolean {
  return !!ctx.state.impact && customerIds(ctx).length > 0 && !/\bCUST-\d+/.test(ctx.state.impact);
}
