import Anthropic from "@anthropic-ai/sdk";
import { isRetryableStatus, parseRetryAfter, withRetry, type RetryableInfo } from "./retry";
import type { ChatSession, ModelTurn, SendOptions, SessionConfig, ToolResult } from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export class AnthropicSession implements ChatSession {
  readonly provider = "anthropic" as const;
  readonly model: string;
  readonly history: Anthropic.MessageParam[];
  private readonly tools: Anthropic.Tool[];

  constructor(
    private readonly cfg: SessionConfig,
    private readonly client: Anthropic = new Anthropic({ maxRetries: 0 }), // retries handled by withRetry
  ) {
    this.model = cfg.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    this.history = (cfg.history as Anthropic.MessageParam[] | undefined) ?? [];
    this.tools = cfg.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: "object", ...t.parameters } as Anthropic.Tool.InputSchema,
    }));
  }

  async send(opts: SendOptions): Promise<ModelTurn> {
    const deadline = Date.now() + opts.timeoutMs;
    const response = await withRetry(
      () =>
        this.client.messages.create(
          {
            model: this.model,
            max_tokens: 16000,
            system: this.cfg.system,
            tools: this.tools,
            messages: this.history,
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: this.cfg.effort ?? "medium" },
            cache_control: { type: "ephemeral" },
          },
          { timeout: Math.max(1000, deadline - Date.now()), maxRetries: 0 },
        ),
      { classify: classifyAnthropicError, deadline, onRetry: opts.onRetry, reserveMs: opts.reserveMs },
    );

    const stopReason =
      response.stop_reason === "tool_use"
        ? "tool_use"
        : response.stop_reason === "max_tokens"
          ? "max_tokens"
          : response.stop_reason === "refusal"
            ? "refusal"
            : "end_turn";
    if (stopReason === "tool_use" || stopReason === "end_turn") {
      this.history.push({ role: "assistant", content: response.content });
    }

    const thought: string[] = [];
    for (const b of response.content) {
      if (b.type === "thinking" && b.thinking) thought.push(b.thinking);
      if (b.type === "text" && b.text) thought.push(b.text);
    }
    return {
      stopReason,
      thought: thought.join("\n").trim(),
      toolCalls: response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
    };
  }

  addToolResults(results: ToolResult[]) {
    // All results from one turn go back in a single user message.
    this.history.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.callId,
        content: JSON.stringify(r.output),
        is_error: r.isError || undefined,
      })),
    });
  }

  addUserText(text: string) {
    const last = this.history[this.history.length - 1];
    if (last?.role === "user") {
      const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
      last.content = [...content, { type: "text", text }];
    } else {
      this.history.push({ role: "user", content: text });
    }
  }
}

export function classifyAnthropicError(err: unknown): RetryableInfo | null {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return null; // our deadline, not a transient fault
  if (err instanceof Anthropic.APIConnectionError) return {};
  if (err instanceof Anthropic.APIError && isRetryableStatus(err.status)) {
    const headers = err.headers as Headers | undefined;
    return { status: err.status, retryAfterMs: parseRetryAfter(headers?.get?.("retry-after")) };
  }
  return null;
}
