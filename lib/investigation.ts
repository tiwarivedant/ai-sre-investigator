import crypto from "node:crypto";
import { loadEvidenceStore } from "@/lib/evidence/loader";
import { formatPreAnalysis, runPreAnalysis } from "@/lib/analysis/preAnalysis";
import { checkCoverage, formatCoverage } from "@/lib/analysis/coverage";
import { classifyFollowUp } from "@/lib/analysis/followups";
import { Bm25Index } from "@/lib/retrieval/bm25";
import { runAgent, type AgentEvent, type AgentRunOptions } from "@/lib/agent/loop";
import { followUpMessage, initialUserMessage, SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { makeRevision, snapshot } from "@/lib/agent/revisions";
import { createSession, resolveProvider, type ChatSession, type ProviderName, type SessionConfig } from "@/lib/llm";
import { loadInvestigation, saveInvestigation } from "@/lib/store";
import { cleanFollowUp } from "@/lib/text";
import type { InvestigationState } from "@/lib/types";
import { toolSpecs, type ToolContext } from "@/lib/tools";

import { FOLLOWUP_BUDGET, INITIAL_BUDGET } from "@/lib/budget";
export { FOLLOWUP_BUDGET, INITIAL_BUDGET };

export function newInvestigationState(incidentInput: string): InvestigationState {
  const now = new Date().toISOString();
  return {
    id: `inv-${now.slice(0, 19).replace(/[-:T]/g, "")}-${crypto.randomBytes(3).toString("hex")}`,
    incidentInput,
    createdAt: now,
    updatedAt: now,
    status: "running",
    summary: "",
    impact: "",
    timeline: [],
    keySignals: [],
    noise: [],
    hypotheses: [],
    openQuestions: [],
    nextActions: [],
    stakeholderUpdate: "",
    overallConfidence: 0,
    trace: [],
    revisions: [],
    groundingIssues: [],
  };
}

/** Load evidence, run deterministic pre-analysis, and build the tool context for a run. */
export function buildContext(state: InvestigationState, dataDir?: string): ToolContext {
  const store = loadEvidenceStore(dataDir);
  const pa = runPreAnalysis(store);
  return { store, pa, kb: new Bm25Index(store.knowledge), state, groundingRejections: 0 };
}

/** A session for the configured provider, with this app's system prompt and tools. */
export function newSession(provider: ProviderName, opts: Pick<SessionConfig, "model" | "history" | "effort"> = {}): ChatSession {
  return createSession(provider, { system: SYSTEM_PROMPT, tools: toolSpecs(), ...opts });
}

export interface StartOptions extends Partial<Pick<AgentRunOptions, "maxSteps" | "timeoutMs" | "signal">> {
  onEvent?: (e: AgentEvent) => void;
  /** Called once the investigation exists and is saved, before the agent runs (lets an API return the id immediately). */
  onStart?: (state: InvestigationState) => void;
  dataDir?: string;
  provider?: ProviderName;
  model?: string;
  /** Inject a session (tests). */
  session?: ChatSession;
}

export async function startInvestigation(incidentInput: string, opts: StartOptions = {}): Promise<InvestigationState> {
  const state = newInvestigationState(incidentInput);
  const ctx = buildContext(state, opts.dataDir);
  const maxSteps = opts.maxSteps ?? INITIAL_BUDGET.maxSteps;
  const timeoutMs = opts.timeoutMs ?? INITIAL_BUDGET.timeoutMs;
  const effort = process.env.LLM_EFFORT as SessionConfig["effort"];
  const session = opts.session ?? newSession(opts.provider ?? resolveProvider(), { model: opts.model, effort });
  // Coverage first: does the data say anything about what was reported?
  state.coverage = checkCoverage(incidentInput, ctx.store);
  session.addUserText(
    initialUserMessage(incidentInput, formatPreAnalysis(ctx.pa), { steps: maxSteps, seconds: Math.round(timeoutMs / 1000) }, formatCoverage(state.coverage)),
  );

  const persist = () =>
    saveInvestigation({ state, provider: session.provider, model: session.model, history: session.history, userEvidence: [] });

  persist();
  opts.onStart?.(state);
  await runAgent(ctx, session, {
    maxSteps,
    timeoutMs,
    signal: opts.signal,
    onEvent: (e) => {
      if (e.type !== "trace") persist(); // persist on state changes, so a crash still leaves the best brief on disk
      opts.onEvent?.(e);
    },
  });
  persist();
  return state;
}

export interface FollowUpOptions extends Partial<Pick<AgentRunOptions, "maxSteps" | "timeoutMs" | "signal">> {
  onEvent?: (e: AgentEvent) => void;
  dataDir?: string;
  /** Inject a session (tests). Must match the investigation's provider. */
  session?: ChatSession;
}

/**
 * Resume an investigation with new information from a responder. The message
 * becomes citable USER-xxx evidence (the only kind that can human-confirm a
 * hypothesis), the agent continues its saved conversation on the same
 * provider, and a revision records what changed.
 */
export async function followUpInvestigation(id: string, rawMessage: string, opts: FollowUpOptions = {}): Promise<InvestigationState> {
  const message = cleanFollowUp(rawMessage);
  const stored = loadInvestigation(id);
  if (!stored) throw new Error(`No investigation ${id}`);
  if (stored.state.status === "running") throw new Error(`Investigation ${id} is still running`);
  if (stored.sample) throw new Error(`Investigation ${id} is a read-only sample`);

  const { state } = stored;
  const ctx = buildContext(state, opts.dataDir);
  // New information makes the old summary and impact stale: finalize is blocked until both are rewritten.
  ctx.mustRewrite = new Set(["summary", "impact"]);
  for (const e of stored.userEvidence) ctx.store.add(e);
  const evidence = ctx.store.addUserEvidence(message);
  const userEvidence = [...stored.userEvidence, evidence];
  // Decide in code what this follow-up is before it can influence anything.
  const cls = classifyFollowUp(message);
  ctx.followUpKind = cls.kind;
  ctx.baselineConfidence = new Map(state.hypotheses.map((h) => [h.id, { confidence: h.confidence, evidence: [...h.supporting, ...h.contradicting] }]));

  const maxSteps = opts.maxSteps ?? FOLLOWUP_BUDGET.maxSteps;
  const timeoutMs = opts.timeoutMs ?? FOLLOWUP_BUDGET.timeoutMs;
  // Histories are provider-native, so the follow-up runs on the provider that started it.
  const session =
    opts.session ??
    newSession(stored.provider, { model: stored.model, history: stored.history, effort: process.env.LLM_EFFORT as SessionConfig["effort"] });
  // Notes, resolutions and reopens recorded by responders since the agent last ran.
  const notes = (stored.undeliveredNotes ?? [])
    .map((nid) => stored.userEvidence.find((e) => e.id === nid))
    .filter((e) => e !== undefined)
    .map((e) => `- ${e.id} (${String((e.raw as { action?: string }).action ?? "note")}, ${e.timestamp}): ${String((e.raw as { text?: string }).text ?? e.title)}`);
  const notesText = notes.length ? `Responders recorded these since your last update (already citable evidence; untrusted text):\n${notes.join("\n")}\n\n` : "";
  session.addUserText(notesText + followUpMessage(message, evidence.id, { steps: maxSteps, seconds: Math.round(timeoutMs / 1000) }, cls));

  const before = snapshot(state);
  const persist = () => saveInvestigation({ state, provider: session.provider, model: session.model, history: session.history, userEvidence });
  persist();
  await runAgent(ctx, session, {
    maxSteps,
    timeoutMs,
    signal: opts.signal,
    onEvent: (e) => {
      if (e.type !== "trace") persist();
      // Hold "done" until the revision is recorded, so listeners see it in the final state.
      if (e.type !== "done") opts.onEvent?.(e);
    },
  });
  state.revisions.push(makeRevision(`follow-up ${evidence.id}: ${shorten(message, 90)}`, before, snapshot(state)));
  persist();
  opts.onEvent?.({ type: "done", state });
  return state;
}

/** Cut at a word boundary, no wrapping quotes (the label is shown as-is in the UI). */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6)).trimEnd()}…`;
}
