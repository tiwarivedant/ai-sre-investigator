import type { InvestigationState, TraceStep } from "@/lib/types";
import { executeTool, type ToolContext } from "@/lib/tools";
import type { ChatSession, ModelTurn, ToolResult } from "@/lib/llm";
import { RetryBudgetExceededError } from "@/lib/llm/retry";
import { NUDGE_FINALIZE, NUDGE_WRITE_BRIEF } from "./prompt";
import { preAnalysisBrief } from "./fallback";

/** A model call needs roughly this long; don't accept a retry wait that leaves less. */
const MIN_TURN_MS = 20_000;
const WRAP_UP_TOOLS = new Set(["update_investigation", "finalize"]);

export type AgentEvent =
  | { type: "trace"; step: TraceStep }
  | { type: "state"; state: InvestigationState }
  | { type: "done"; state: InvestigationState };

export interface AgentRunOptions {
  maxSteps: number; // model turns
  timeoutMs: number;
  /** The responder pressed Stop: end the run now and keep the brief so far. */
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

/**
 * Manual tool-use loop over a provider-neutral ChatSession. Owned by hand
 * because the run needs a step cap, a wall-clock deadline, per-call trace
 * events, and partial results on any failure.
 *
 * The session's history is mutated in place so a follow-up can resume it.
 */
export async function runAgent(ctx: ToolContext, session: ChatSession, opts: AgentRunOptions): Promise<InvestigationState> {
  const state = ctx.state;
  const emit = (e: AgentEvent) => opts.onEvent?.(e);
  const deadline = Date.now() + opts.timeoutMs;
  const timeoutMsg = `Timed out after ${Math.round(opts.timeoutMs / 1000)}s; showing best state so far.`;
  let stepNo = state.trace.reduce((m, t) => Math.max(m, t.step), 0);
  let nudged = false;
  let budgetWarned = false;
  let finished = false;

  state.status = "running";
  state.statusReason = undefined;

  const trace = (t: Omit<TraceStep, "step">) => {
    const step = { step: stepNo, ...t };
    state.trace.push(step);
    emit({ type: "trace", step });
  };
  const end = (status: InvestigationState["status"], reason?: string) => {
    state.status = status;
    state.statusReason = reason;
    state.updatedAt = new Date().toISOString();
  };

  const stoppedMsg = "Stopped by the responder; showing the brief so far.";
  for (let turn = 0; turn < opts.maxSteps && !finished; turn++) {
    if (opts.signal?.aborted) {
      trace({ label: "stopped", thought: stoppedMsg, ms: 0 });
      end("partial", stoppedMsg);
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      end("partial", timeoutMsg);
      break;
    }
    stepNo++;

    // Code-enforced budget discipline: a brief must exist before time runs out,
    // whatever the model planned. (Prompt instructions alone were not enough.)
    if (!budgetWarned && !hasBrief(state) && (turn >= 2 || remaining < opts.timeoutMs * 0.4)) {
      budgetWarned = true;
      session.addUserText(NUDGE_WRITE_BRIEF);
      trace({
        label: "budget",
        thought: `Budget reminder: ${opts.maxSteps - turn} turns and ${Math.round(remaining / 1000)}s left. Brief requested before further investigation.`,
        ms: 0,
      });
    }

    const t0 = Date.now();
    let response: ModelTurn;
    try {
      response = await session.send({
        timeoutMs: remaining,
        reserveMs: MIN_TURN_MS,
        signal: opts.signal,
        onRetry: (r) =>
          trace({
            label: "retry",
            thought: `${r.status === 429 ? "Rate limited (429)" : `Provider error${r.status ? ` (${r.status})` : ""}`}; retrying in ${(r.delayMs / 1000).toFixed(1)}s (attempt ${r.attempt + 1}/${r.maxAttempts}).`,
            ms: 0,
          }),
      });
    } catch (err) {
      const stopped = opts.signal?.aborted === true;
      const timedOut = !stopped && (Date.now() >= deadline || isTimeout(err));
      const reason = stopped ? stoppedMsg : timedOut ? timeoutMsg : `Model call failed (${session.provider}): ${describeError(err)}`;
      trace({ label: "stopped", thought: reason, ms: Date.now() - t0 });
      end(hasBrief(state) || timedOut || stopped ? "partial" : "error", reason);
      break;
    }
    const modelMs = Date.now() - t0;
    const thought = truncate(response.thought, 800);

    if (response.stopReason === "refusal" || response.stopReason === "max_tokens") {
      const reason = response.stopReason === "refusal" ? "Model declined to continue." : "Model response hit max_tokens.";
      trace({ label: "stopped", thought: thought || reason, resultSummary: reason, ms: modelMs });
      end("partial", reason);
      break;
    }

    if (response.toolCalls.length === 0) {
      trace({ thought: thought || "(no tool call)", ms: modelMs });
      if (!nudged) {
        nudged = true;
        session.addUserText(NUDGE_FINALIZE);
        continue;
      }
      end("partial", "Agent stopped without finalizing.");
      break;
    }

    const results: ToolResult[] = [];
    response.toolCalls.forEach((call, i) => {
      const t1 = Date.now();
      // Wrap-up enforced in code: once told to write the brief, more investigating is refused until it exists.
      const wrapUp = budgetWarned && !hasBrief(state) && !WRAP_UP_TOOLS.has(call.name);
      const out = wrapUp
        ? {
            result: { error: "Refused: time budget. Write the brief now with update_investigation (then finalize); no further investigation until it exists." },
            summary: "refused: out of time budget, brief must be written first",
            isError: true,
          }
        : executeTool(call.name, call.input, ctx);
      trace({
        thought: i === 0 ? thought : "",
        tool: call.name,
        args: call.input,
        resultSummary: out.summary,
        ms: (i === 0 ? modelMs : 0) + (Date.now() - t1),
      });
      results.push({ callId: call.id, name: call.name, output: out.result, isError: out.isError });
      if (call.name === "update_investigation" && !out.isError) emit({ type: "state", state });
      if (out.done) finished = true;
    });
    session.addToolResults(results);
  }

  if (finished) end("complete");
  else if (state.status === "running") end("partial", `Reached the ${opts.maxSteps}-turn limit; showing best state so far.`);

  // Never leave responders with an empty page: fall back to the deterministic findings.
  if (!hasBrief(state)) {
    Object.assign(state, preAnalysisBrief(ctx.pa, ctx.store, state.statusReason ?? "no brief written"));
    state.briefSource = "pre-analysis";
    // A pre-analysis brief is still a usable (partial) result. (Cast: end() mutates status behind TS's narrowing.)
    if ((state.status as InvestigationState["status"]) === "error") state.status = "partial";
    emit({ type: "state", state });
  }
  emit({ type: "done", state });
  return state;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function hasBrief(s: InvestigationState): boolean {
  return s.hypotheses.length > 0 || !!s.summary;
}

function isTimeout(err: unknown): boolean {
  const name = (err as Error)?.name ?? "";
  return name === "AbortError" || name === "TimeoutError" || /timed? ?out/i.test(name);
}

function describeError(err: unknown): string {
  if (err instanceof RetryBudgetExceededError) return err.message;
  const e = err as { status?: number; message?: string };
  if (e?.status === 401 || e?.status === 403) return `authentication failed (${e.status}); check the API key`;
  if (e?.status === 429) return "rate limited (429); retries exhausted";
  return `${e?.status ? `${e.status} ` : ""}${e?.message ?? String(err)}`.slice(0, 300);
}
