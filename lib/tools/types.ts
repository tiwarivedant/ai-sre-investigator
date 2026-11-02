import type { z } from "zod";
import type { EvidenceStore } from "@/lib/evidence/loader";
import type { PreAnalysis } from "@/lib/analysis/preAnalysis";
import type { Bm25Index } from "@/lib/retrieval/bm25";
import type { InvestigationState } from "@/lib/types";

export interface ToolContext {
  store: EvidenceStore;
  pa: PreAnalysis;
  kb: Bm25Index;
  state: InvestigationState;
  /** How many updates the grounding guard has rejected this run (rejects once, then strips). */
  groundingRejections: number;
  /** Fields a follow-up must rewrite before finalize (the old text predates the new information). */
  mustRewrite?: Set<"summary" | "impact">;
  /** finalize rejects a contradictory brief once; after that the issues stay visible in the brief instead. */
  consistencyWarned?: boolean;
  /** Class of the follow-up driving this run, if any. Claims and instructions may not move confidence. */
  followUpKind?: import("@/lib/analysis/followups").FollowUpKind;
  /** Hypothesis confidences before this follow-up, restored after a claim/instruction follow-up. */
  baselineConfidence?: Map<string, { confidence: number; evidence: string[] }>;
  /** finalize rejects once when Impact ignores the customer notes that exist. */
  impactWarned?: boolean;
}

export interface ToolOutput {
  result: unknown;
  /** One line for the trace. */
  summary: string;
  isError?: boolean;
  /** Set by `finalize` when the brief is accepted. */
  done?: boolean;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(input: z.infer<S>, ctx: ToolContext): ToolOutput;
}

export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool<S> {
  return tool;
}

/** Accept "14:05", "2026-10-28T14:05", or full ISO; return ISO on the incident date. */
export function normTime(t: string | undefined, incidentDate: string): string | undefined {
  if (!t) return undefined;
  if (/^\d{1,2}:\d{2}$/.test(t)) {
    const [h, m] = t.split(":");
    return `${incidentDate}T${h.padStart(2, "0")}:${m}:00Z`;
  }
  const ms = Date.parse(t.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().replace(".000Z", "Z");
}

export const inRange = (ts: string | undefined, from?: string, to?: string) =>
  !!ts && (!from || ts >= from) && (!to || ts <= to);
