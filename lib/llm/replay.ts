import fs from "node:fs";
import path from "node:path";
import type { ChatSession, ModelTurn, ProviderName, SendOptions, ToolResult } from "./types";

/**
 * Replay mode (REPLAY=1). A fixture holds the model turns of a recorded run;
 * ReplaySession serves them back in order. Only the LLM is replayed: tools,
 * the grounding guard, calibration policy and revisions all run for real
 * against the evidence store, so a replayed run exercises the whole system
 * except the model. Used for the UI, demos without an API key, and tests.
 *
 * Fixtures are extracted from saved investigations (which keep the full
 * provider-native conversation): `npm run save-fixture -- latest`.
 */

export const FIXTURE_DIR = path.join(process.cwd(), "fixtures");
export const DEFAULT_FIXTURE = "inc-2213";
const FOLLOWUP_MARKER = "<responder_followup>";

export interface FixtureRun {
  kind: "initial" | "followup";
  /** The responder's follow-up message, for follow-up runs. */
  message?: string;
  turns: ModelTurn[];
}

export interface Fixture {
  name: string;
  recordedAt: string;
  source: { provider: ProviderName; model: string; investigationId: string };
  incidentInput: string;
  runs: FixtureRun[];
}

export function loadFixture(name = process.env.REPLAY_FIXTURE ?? DEFAULT_FIXTURE): Fixture {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  if (!/^[\w.-]+$/.test(name) || !fs.existsSync(file)) {
    throw new Error(`Replay fixture "${name}" not found in fixtures/. Record one with: npm run save-fixture -- latest`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
}

/** The responder follow-ups the fixture recorded, in order. */
export function recordedFollowUps(f: Fixture): string[] {
  return f.runs.filter((r) => r.kind === "followup").map((r) => r.message ?? "");
}

// --- Extraction from saved provider-native histories -------------------------

type GeminiPart = { text?: string; thought?: boolean; functionCall?: { id?: string; name?: string; args?: unknown } };
type GeminiContent = { role?: string; parts?: GeminiPart[] };
type AnthropicBlock = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
type AnthropicMessage = { role: string; content: string | AnthropicBlock[] };

export function extractRuns(provider: ProviderName, history: unknown[]): FixtureRun[] {
  const runs: FixtureRun[] = [{ kind: "initial", turns: [] }];
  const current = () => runs[runs.length - 1];
  let n = 0;

  const onUserText = (text: string) => {
    const i = text.indexOf(FOLLOWUP_MARKER);
    if (i < 0) return;
    const end = text.indexOf("</responder_followup>", i);
    runs.push({ kind: "followup", message: text.slice(i + FOLLOWUP_MARKER.length, end < 0 ? undefined : end).trim(), turns: [] });
  };

  for (const entry of history) {
    if (provider === "gemini") {
      const c = entry as GeminiContent;
      const parts = c.parts ?? [];
      if (c.role === "model") {
        const calls = parts.filter((p) => p.functionCall);
        current().turns.push({
          stopReason: calls.length ? "tool_use" : "end_turn",
          thought: parts.filter((p) => p.text && !p.functionCall).map((p) => p.text!.trim()).join("\n"),
          toolCalls: calls.map((p) => ({ id: p.functionCall!.id ?? `replay_${++n}`, name: p.functionCall!.name ?? "", input: p.functionCall!.args ?? {} })),
        });
      } else {
        for (const p of parts) if (p.text) onUserText(p.text);
      }
    } else if (provider === "anthropic") {
      const m = entry as AnthropicMessage;
      const blocks: AnthropicBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      if (m.role === "assistant") {
        const calls = blocks.filter((b) => b.type === "tool_use");
        current().turns.push({
          stopReason: calls.length ? "tool_use" : "end_turn",
          thought: blocks.map((b) => (b.type === "thinking" ? b.thinking : b.type === "text" ? b.text : "") ?? "").filter(Boolean).join("\n"),
          toolCalls: calls.map((b) => ({ id: b.id ?? `replay_${++n}`, name: b.name ?? "", input: b.input ?? {} })),
        });
      } else {
        for (const b of blocks) if (b.type === "text" && b.text) onUserText(b.text);
      }
    } else {
      throw new Error(`Cannot extract a fixture from a ${provider} history`);
    }
  }
  return runs;
}

// --- Replay session ----------------------------------------------------------

/** Neutral history kept by replay sessions so replayed investigations can be saved and followed up. */
type ReplayEntry = { role: "user"; text: string } | { role: "model"; turn: ModelTurn } | { role: "tool"; results: ToolResult[] };

export class ReplaySession implements ChatSession {
  readonly provider = "replay" as const;
  readonly model: string;
  readonly history: ReplayEntry[];

  constructor(
    private readonly fixture: Fixture,
    history?: unknown[],
    private readonly delayMs = Number(process.env.REPLAY_DELAY_MS ?? 600),
  ) {
    this.model = `replay:${fixture.name}`;
    this.history = (history as ReplayEntry[] | undefined) ?? [];
  }

  async send(opts: SendOptions): Promise<ModelTurn> {
    // Simulated latency so streaming UIs behave like a live run (never past the deadline).
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(this.delayMs, Math.max(0, opts.timeoutMs - 50))));

    // Which recorded run are we in, and how many of its turns have been served?
    let runIndex = 0;
    let served = 0;
    for (const e of this.history) {
      if (e.role === "user" && e.text.includes(FOLLOWUP_MARKER)) {
        runIndex++;
        served = 0;
      } else if (e.role === "model") served++;
    }
    const run = this.fixture.runs[runIndex];
    const turn = run?.turns[served];
    if (!turn) {
      return {
        stopReason: "end_turn",
        toolCalls: [],
        thought: run ? "(replay: no more recorded turns for this run)" : `(replay: fixture "${this.fixture.name}" has no recorded run #${runIndex + 1})`,
      };
    }
    const copy = structuredClone(turn);
    this.history.push({ role: "model", turn: copy });
    return copy;
  }

  addToolResults(results: ToolResult[]) {
    this.history.push({ role: "tool", results });
  }

  addUserText(text: string) {
    this.history.push({ role: "user", text });
  }
}
