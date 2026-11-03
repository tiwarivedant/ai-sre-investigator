// Provider-neutral interface the agent loop talks to. Each provider keeps its
// own native message history (thinking blocks / thought signatures must be
// replayed verbatim), so history is opaque here and persisted as-is.

export type ProviderName = "anthropic" | "gemini" | "replay";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  /** JSON-serialisable tool output. */
  output: unknown;
  isError?: boolean;
}

export type StopReason = "tool_use" | "end_turn" | "max_tokens" | "refusal";

export interface ModelTurn {
  stopReason: StopReason;
  toolCalls: ToolCall[];
  /** Thinking summary and/or visible text, for the trace. */
  thought: string;
}

export interface RetryNotice {
  attempt: number; // the attempt that just failed, 1-based
  maxAttempts: number;
  delayMs: number;
  status?: number;
}

export interface SendOptions {
  /** Hard wall-clock budget for this call, including retries. */
  timeoutMs: number;
  onRetry?: (n: RetryNotice) => void;
  /** Don't accept a retry wait unless at least this much time would remain afterwards. */
  reserveMs?: number;
  /** Aborts the call (the responder pressed Stop). */
  signal?: AbortSignal;
}

export interface ChatSession {
  readonly provider: ProviderName;
  readonly model: string;
  /** Provider-native history, persisted verbatim so a follow-up can resume. */
  readonly history: unknown[];
  /**
   * Send the history and append the model's reply to it. Replies that stop on
   * max_tokens or refusal are NOT appended (they may hold half-formed tool calls).
   */
  send(opts: SendOptions): Promise<ModelTurn>;
  addToolResults(results: ToolResult[]): void;
  /** Add user text, merging into a trailing user turn (e.g. one holding tool results). */
  addUserText(text: string): void;
}

export interface SessionConfig {
  system: string;
  tools: ToolSpec[];
  model?: string;
  /** Existing native history to resume from. */
  history?: unknown[];
  effort?: "low" | "medium" | "high";
}
