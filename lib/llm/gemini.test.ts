import { describe, expect, it } from "vitest";
import { ApiError, type Content, type GenerateContentParameters } from "@google/genai";
import { GeminiSession, type GeminiClient } from "./gemini";
import { runAgent } from "@/lib/agent/loop";
import { buildContext, newInvestigationState } from "@/lib/investigation";
import { toolSpecs } from "@/lib/tools";

// Scripted fake of the Gemini client: each entry is either a model Content to
// return or an error to throw.
function fakeGemini(script: (Content | { finishReason: string; parts?: Content["parts"] } | Error)[]) {
  const requests: GenerateContentParameters[] = [];
  let i = 0;
  const client: GeminiClient = {
    models: {
      generateContent: (async (params: GenerateContentParameters) => {
        requests.push(structuredClone({ ...params, config: { ...params.config, abortSignal: undefined } }));
        const step = script[Math.min(i++, script.length - 1)];
        if (step instanceof Error) throw step;
        if ("finishReason" in step) return { candidates: [{ content: { role: "model", parts: step.parts ?? [] }, finishReason: step.finishReason }] };
        return { candidates: [{ content: step, finishReason: "STOP" }] };
      }) as GeminiClient["models"]["generateContent"],
    },
  };
  return { client, requests };
}

const call = (name: string, args: Record<string, unknown>, id?: string) => ({ functionCall: { name, args, ...(id ? { id } : {}) } });

const brief = {
  summary: "Leading explanation per CFG-502.",
  impact: "Checkout errors (MET-checkout.error_rate_pct); 87 support tickets (CUST-001).",
  timeline: [{ ts: "2026-10-28T13:52:00Z", evidenceId: "CFG-502", note: "pool raised" }],
  hypotheses: [
    { id: "H1", statement: "pool change", confidence: 0.8, status: "active", supporting: ["CFG-502"], contradicting: [], reasoning: "math" },
    { id: "H2", statement: "payments deploy", confidence: 0.05, status: "rejected", supporting: ["DEP-102"], contradicting: [], reasoning: "payments metrics flat" },
  ],
  nextActions: [{ action: "Revert pool", type: "config_revert", evidence: ["CFG-502"] }],
  openQuestions: ["Did the inventory team intend the pool change?"],
  stakeholderUpdate: "We know why. Fix in progress. Next update in 30 minutes.",
  overallConfidence: 0.8,
};

describe("GeminiSession", () => {
  it("translates tools, replays model content verbatim, and answers function calls by id", async () => {
    const { client, requests } = fakeGemini([
      {
        role: "model",
        parts: [
          { text: "Checking changes first.", thought: true },
          { ...call("get_changes", {}, "fc-1"), thoughtSignature: "sig-abc" },
          call("get_service_context", { service: "orders-db" }),
        ],
      },
    ]);
    const s = new GeminiSession({ system: "sys", tools: toolSpecs(), model: "gemini-test" }, client);
    s.addUserText("go");
    const turn = await s.send({ timeoutMs: 10_000 });

    expect(turn.stopReason).toBe("tool_use");
    expect(turn.thought).toBe("Checking changes first.");
    expect(turn.toolCalls.map((c) => c.name)).toEqual(["get_changes", "get_service_context"]);
    expect(turn.toolCalls[0].id).toBe("fc-1");

    const decls = requests[0].config?.tools?.[0] as { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] };
    expect(decls.functionDeclarations.map((d) => d.name)).toContain("update_investigation");
    expect(requests[0].config?.systemInstruction).toBe("sys");

    // Thought signature must survive into history unchanged.
    expect(JSON.stringify(s.history[1])).toContain("sig-abc");

    s.addToolResults([
      { callId: turn.toolCalls[0].id, name: "get_changes", output: { a: 1 } },
      { callId: turn.toolCalls[1].id, name: "get_service_context", output: { error: "x" }, isError: true },
    ]);
    const responses = s.history[2].parts!.map((p) => p.functionResponse);
    expect(responses[0]).toEqual({ id: "fc-1", name: "get_changes", response: { output: { a: 1 } } });
    expect(responses[1]).toEqual({ name: "get_service_context", response: { error: { error: "x" } } }); // locally minted id not sent
    expect(s.history[2].role).toBe("user");
  });

  it("maps finish reasons and does not keep refused or truncated turns", async () => {
    const { client } = fakeGemini([{ finishReason: "SAFETY" }, { finishReason: "MAX_TOKENS", parts: [{ text: "half" }] }, { finishReason: "MALFORMED_FUNCTION_CALL" }]);
    const s = new GeminiSession({ system: "sys", tools: [], model: "m" }, client);
    s.addUserText("go");
    expect((await s.send({ timeoutMs: 1000 })).stopReason).toBe("refusal");
    expect((await s.send({ timeoutMs: 1000 })).stopReason).toBe("max_tokens");
    const malformed = await s.send({ timeoutMs: 1000 });
    expect(malformed.stopReason).toBe("end_turn");
    expect(malformed.thought).toMatch(/malformed/);
    expect(s.history).toHaveLength(1); // only the user turn
  });

  it("retries a 429 using the server's retryDelay, visible in the trace", async () => {
    const e429 = new ApiError({ status: 429, message: '{"retryDelay": "0.01s"}' });
    const { client, requests } = fakeGemini([e429, { role: "model", parts: [call("update_investigation", brief)] }, { role: "model", parts: [call("finalize", { rationale: "done" })] }]);
    const state = newInvestigationState("checkout errors");
    const ctx = buildContext(state);
    const s = new GeminiSession({ system: "sys", tools: toolSpecs(), model: "m" }, client);
    s.addUserText("go");
    await runAgent(ctx, s, { maxSteps: 5, timeoutMs: 30_000 });

    expect(requests).toHaveLength(3);
    expect(state.trace[0].thought).toMatch(/Rate limited \(429\); retrying in 0\.0s \(attempt 2\/4\)/);
    expect(state.status).toBe("complete");
    expect(state.hypotheses[0].id).toBe("H1");
  });

  it("ends the run partial with a clear reason when 429s persist", async () => {
    const e429 = new ApiError({ status: 429, message: '{"retryDelay": "0s"}' });
    const { client, requests } = fakeGemini([e429]);
    const state = newInvestigationState("x");
    const s = new GeminiSession({ system: "sys", tools: toolSpecs(), model: "m" }, client);
    s.addUserText("go");
    await runAgent(buildContext(state), s, { maxSteps: 5, timeoutMs: 30_000 });

    expect(requests).toHaveLength(4);
    expect(state.statusReason).toMatch(/gemini.*rate limited \(429\); retries exhausted/);
    // No brief from the agent: responders get the deterministic pre-analysis instead of an empty page.
    expect(state.status).toBe("partial");
    expect(state.briefSource).toBe("pre-analysis");
    expect(state.hypotheses).toEqual([]);
  });
});
