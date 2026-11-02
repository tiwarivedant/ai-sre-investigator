import { z } from "zod";

// Everything the agent writes goes through these schemas before it touches state.

const confidence = z.number().min(0).max(1);
const evidenceIds = z.array(z.string().min(1));

export const HypothesisSchema = z.object({
  id: z.string().regex(/^H\d+$/, "Hypothesis ids look like H1, H2, ..."),
  statement: z.string().min(1),
  confidence,
  status: z.enum(["active", "rejected", "confirmed"]).describe('"confirmed" only with human confirmation cited as USER- evidence; code downgrades it otherwise.'),
  supporting: evidenceIds.min(1, "No evidence, no claim: cite at least one supporting evidence ID"),
  contradicting: evidenceIds,
  reasoning: z.string().min(1),
  recoveryEvidence: evidenceIds
    .optional()
    .describe("USER- evidence where a human reports that service recovered after the fix. Confidence above 0.95 requires it."),
});

export const InvestigationUpdateSchema = z
  .object({
    summary: z.string().describe("2-4 sentences: what is happening, the leading explanation, and how sure you are. Cite IDs inline."),
    impact: z
      .string()
      .describe("Who/what is affected and how badly, with evidence IDs inline. Include the customer-facing impact from support notes (CUST-): ticket volume, what customers see, any payment/order integrity concerns."),
    timeline: z
      .array(z.object({ evidenceId: z.string(), note: z.string() }))
      .describe("Key events. Full list; replaces the previous timeline. Times come from the evidence itself, so give only the ID and a note."),
    keySignals: z
      .array(z.object({ evidenceId: z.string(), why: z.string() }))
      .describe("Evidence that matters for cause or impact. Full list; replaces the previous one."),
    noise: z
      .array(z.object({ evidenceId: z.string(), why: z.string() }))
      .describe("Evidence judged unrelated or misleading, and why. Code always adds the alerts its heuristics flag as noise; list them here only to give a better reason."),
    notNoise: z
      .array(z.object({ evidenceId: z.string(), why: z.string().min(1) }))
      .describe("Alerts code flagged as likely noise that you judge are real signal, each with the reason. Full list; replaces the previous one."),
    hypotheses: z
      .array(HypothesisSchema)
      .describe("ALL hypotheses including rejected ones, ranked most likely first. Full list; replaces the previous one. Keep ids stable across updates."),
    openQuestions: z.array(z.string()).describe("What you could not determine from the evidence and who could answer it."),
    nextActions: z
      .array(
        z.object({
          action: z.string(),
          owner: z.string().optional(),
          type: z
            .enum(["investigate", "communicate", "config_revert", "flag_change", "rollback", "pod_restart", "scale", "db_change", "prevention", "other"])
            .describe("What kind of operation this is. Risk is assigned from this by code; you do not set risk."),
          priority: z.enum(["P1", "P2"]).optional().describe('For phase "prevention" only: P1 = prevents this exact failure recurring; P2 = hardening.'),
          phase: z
            .enum(["now", "after_recovery", "prevention"])
            .optional()
            .describe('"after_recovery" for anything that should wait until recovery is verified (e.g. undoing a mitigation); "prevention" for post-incident work that stops a recurrence. Default "now".'),
          evidence: evidenceIds,
        }),
      )
      .describe("Concrete, ordered actions with owner (team/on-call from the service catalog), one operation per action. Risk is assigned by code from the type."),
    contributingFactors: z
      .array(z.object({ factor: z.string(), evidence: evidenceIds.min(1) }))
      .describe("Conditions that let the cause become an incident or made it worse or slower to resolve (missing safeguards, visibility gaps, load). Not the cause itself. Code adds factors it can derive."),
    similarIncidents: z
      .array(
        z.object({
          incidentId: z.string().regex(/^INC-\d+$/).describe("A past incident write-up you retrieved, e.g. INC-1234."),
          hypothesisId: z.string().optional(),
          similarity: z.string().describe("How this incident resembles (or differs from) the past one."),
          lesson: z.string().describe("What the past incident teaches responders now."),
        }),
      )
      .describe("Past incidents that resemble this one. Optional: code also matches past incidents by retrieval."),
    stakeholderUpdate: z
      .string()
      .describe('3-5 plain-language sentences for leadership/support. No jargon, no evidence IDs. Say "likely cause" unless a human has confirmed it.'),
    overallConfidence: confidence.describe("0..1 confidence in the leading hypothesis being the root cause. Capped at 0.85 by code unless a human has confirmed it."),
  })
  .partial()
  .strict();

export type InvestigationUpdate = z.infer<typeof InvestigationUpdateSchema>;

/** zod -> JSON Schema for tool definitions, so the schema has one source of truth. */
export function toInputSchema(schema: z.ZodType): { type: "object"; [k: string]: unknown } {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return json as { type: "object"; [k: string]: unknown };
}
