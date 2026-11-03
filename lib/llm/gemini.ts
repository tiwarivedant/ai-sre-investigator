import { ApiError, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentResponse, type Part } from "@google/genai";
import { isRetryableStatus, withRetry, type RetryableInfo } from "./retry";
import type { ChatSession, ModelTurn, SendOptions, SessionConfig, StopReason, ToolResult } from "./types";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

/** Interface subset of GoogleGenAI used here, so tests can inject a fake. */
export interface GeminiClient {
  models: { generateContent: GoogleGenAI["models"]["generateContent"] };
}

const THINKING_LEVEL = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH } as const;
const LOCAL_ID_PREFIX = "local_call_";
const REFUSAL_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

export class GeminiSession implements ChatSession {
  readonly provider = "gemini" as const;
  readonly model: string;
  readonly history: Content[];
  private callCounter = 0;

  constructor(
    private readonly cfg: SessionConfig,
    private readonly client: GeminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
  ) {
    this.model = cfg.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    this.history = (cfg.history as Content[] | undefined) ?? [];
  }

  async send(opts: SendOptions): Promise<ModelTurn> {
    const deadline = Date.now() + opts.timeoutMs;
    const response: GenerateContentResponse = await withRetry(
      () =>
        this.client.models.generateContent({
          model: this.model,
          contents: this.history,
          config: {
            systemInstruction: this.cfg.system,
            tools: [
              {
                functionDeclarations: this.cfg.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.parameters,
                })),
              },
            ],
            thinkingConfig: { includeThoughts: true, thinkingLevel: THINKING_LEVEL[this.cfg.effort ?? "medium"] },
            maxOutputTokens: 16000,
            abortSignal: opts.signal
              ? AbortSignal.any([AbortSignal.timeout(Math.max(1000, deadline - Date.now())), opts.signal])
              : AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
          },
        }),
      { classify: classifyGeminiError, deadline, onRetry: opts.onRetry, reserveMs: opts.reserveMs },
    );

    const candidate = response.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    const finish = String(candidate?.finishReason ?? "");

    let stopReason: StopReason;
    if (!candidate && response.promptFeedback?.blockReason) stopReason = "refusal";
    else if (REFUSAL_REASONS.has(finish)) stopReason = "refusal";
    else if (finish === "MAX_TOKENS") stopReason = "max_tokens";
    else if (calls.length) stopReason = "tool_use";
    else stopReason = "end_turn"; // includes MALFORMED_FUNCTION_CALL: the loop nudges the model to retry

    // Replay the model's content verbatim (thought signatures must round-trip). Gemini rejects empty turns.
    if ((stopReason === "tool_use" || stopReason === "end_turn") && candidate?.content && parts.length) {
      this.history.push({ ...candidate.content, role: "model" });
    }

    const thought = parts
      .filter((p) => p.text && !p.functionCall)
      .map((p) => p.text!.trim())
      .filter(Boolean);
    if (finish === "MALFORMED_FUNCTION_CALL") thought.push("(model produced a malformed function call)");

    return {
      stopReason,
      thought: thought.join("\n"),
      toolCalls: calls.map((p) => ({
        id: p.functionCall!.id ?? `${LOCAL_ID_PREFIX}${++this.callCounter}`,
        name: p.functionCall!.name ?? "",
        input: p.functionCall!.args ?? {},
      })),
    };
  }

  addToolResults(results: ToolResult[]) {
    this.history.push({
      role: "user",
      parts: results.map((r) => ({
        functionResponse: {
          // Echo Gemini's call id when it gave one; ids we minted are ours alone.
          ...(r.callId.startsWith(LOCAL_ID_PREFIX) ? {} : { id: r.callId }),
          name: r.name,
          response: r.isError ? { error: r.output } : { output: r.output },
        },
      })),
    });
  }

  addUserText(text: string) {
    const last = this.history[this.history.length - 1];
    if (last?.role === "user") last.parts = [...(last.parts ?? []), { text }];
    else this.history.push({ role: "user", parts: [{ text }] });
  }
}

export function classifyGeminiError(err: unknown): RetryableInfo | null {
  const name = (err as Error)?.name;
  if (name === "AbortError" || name === "TimeoutError") return null; // our deadline
  if (err instanceof ApiError) {
    if (!isRetryableStatus(err.status)) return null;
    // 429 bodies carry google.rpc.RetryInfo, e.g. "retryDelay": "17s".
    const m = err.message.match(/retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/);
    return { status: err.status, retryAfterMs: m ? Number(m[1]) * 1000 : undefined };
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return {}; // network blip
  return null;
}
