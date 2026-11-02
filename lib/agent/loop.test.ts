import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./loop";
import { buildContext, newInvestigationState } from "@/lib/investigation";
import { AnthropicSession } from "@/lib/llm/anthropic";
import { toolSpecs } from "@/lib/tools";
import { checkGrounding } from "./grounding";

// The loop is tested against a scripted fake client: no network, deterministic.

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

function fakeClient(turns: Block[][]): { client: Anthropic; requests: Anthropic.MessageCreateParams[] } {
  const requests: Anthropic.MessageCreateParams[] = [];
  let i = 0;
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        requests.push(structuredClone(params));
        const blocks = turns[Math.min(i++, turns.length - 1)];
        const content = blocks.map((b, j) =>
          b.type === "tool_use" ? { type: "tool_use", id: `tu_${i}_${j}`, name: b.name, input: b.input } : { type: "text", text: b.text, citations: null },
        );
        return {
          id: `msg_${i}`,
          type: "message",
          role: "assistant",
          model: "fake",
          content,
          stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
          stop_details: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const goodHypothesis = {
  id: "H1",
  statement: "inventory pool change exhausted orders-db connections",
  confidence: 0.8,
  status: "active",
  supporting: ["CFG-502", "LOG-076"],
  contradicting: [],
  reasoning: "pool math",
};

const completeBrief = {
  summary: "Leading explanation per CFG-502.",
  impact: "Checkout errors (MET-checkout.error_rate_pct); 87 support tickets (CUST-001).",
  timeline: [{ ts: "2026-10-28T13:52:00Z", evidenceId: "CFG-502", note: "pool raised" }],
  hypotheses: [goodHypothesis],
  nextActions: [{ action: "Revert pool", owner: "@inventory-oncall", type: "config_revert", evidence: ["CFG-502"] }],
  openQuestions: ["Did the inventory team intend the pool change?"],
  stakeholderUpdate: "Customers see checkout errors. We know why. Fix in progress.",
  overallConfidence: 0.8,
};

function setup() {
  const state = newInvestigationState("checkout errors");
  return { state, ctx: buildContext(state) };
}

const opts = (maxSteps = 10) => ({ maxSteps, timeoutMs: 30_000 });
const session = (client: Anthropic) =>
  new AnthropicSession({ system: "sys", tools: toolSpecs(), model: "fake", history: [{ role: "user", content: "go" }] }, client);

describe("runAgent", () => {
  it("runs tools, writes state, and completes on finalize", async () => {
    const { ctx, state } = setup();
    const { client, requests } = fakeClient([
      [
        { type: "text", text: "Check changes and the DB." },
        { type: "tool_use", name: "get_changes", input: {} },
        { type: "tool_use", name: "get_service_context", input: { service: "orders-db" } },
      ],
      [{ type: "tool_use", name: "update_investigation", input: completeBrief }],
      [{ type: "tool_use", name: "finalize", input: { rationale: "enough" } }],
    ]);
    const events: string[] = [];
    await runAgent(ctx, session(client), { ...opts(), onEvent: (e) => events.push(e.type) });

    expect(state.status).toBe("complete");
    expect(state.hypotheses[0].id).toBe("H1");
    expect(state.trace.map((t) => t.tool)).toEqual(["get_changes", "get_service_context", "update_investigation", "finalize"]);
    expect(state.trace[0].thought).toBe("Check changes and the DB.");
    expect(state.trace[1].step).toBe(1); // parallel calls share the turn number
    expect(events).toContain("state");
    expect(events.at(-1)).toBe("done");
    // Both parallel tool results go back in a single user message.
    const second = requests[1].messages.at(-1)!;
    expect(second.role).toBe("user");
    expect((second.content as unknown[]).length).toBe(2);
  });

  it("grounding guard rejects unknown IDs once, then strips them", async () => {
    const { ctx, state } = setup();
    const bad = { hypotheses: [{ ...goodHypothesis, supporting: ["CFG-502", "LOG-999"] }], summary: "See DEP-777." };
    const { client, requests } = fakeClient([
      [{ type: "tool_use", name: "update_investigation", input: bad }],
      [{ type: "tool_use", name: "update_investigation", input: bad }],
      [{ type: "tool_use", name: "update_investigation", input: completeBrief }],
      [{ type: "tool_use", name: "finalize", input: { rationale: "ok" } }],
    ]);
    await runAgent(ctx, session(client), opts());

    const firstResult = (requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0];
    expect(firstResult.is_error).toBe(true);
    expect(String(firstResult.content)).toContain("LOG-999");
    expect(state.trace[0].resultSummary).toMatch(/rejected by grounding guard/);
    // Second attempt accepted with bad citations stripped and recorded.
    expect(state.trace[1].resultSummary).toMatch(/stripped/);
    expect(state.groundingIssues.join(" ")).toContain("LOG-999");
    expect(state.groundingIssues.join(" ")).toContain("DEP-777");
    expect(state.status).toBe("complete");
  });

  it("rejects invalid input via zod and an incomplete finalize", async () => {
    const { ctx, state } = setup();
    const { client } = fakeClient([
      [{ type: "tool_use", name: "update_investigation", input: { overallConfidence: 1.7 } }],
      [{ type: "tool_use", name: "finalize", input: { rationale: "done?" } }],
      [{ type: "tool_use", name: "update_investigation", input: { hypotheses: [{ ...goodHypothesis, supporting: [] }] } }],
    ]);
    await runAgent(ctx, session(client), opts(3));

    const calls = state.trace.filter((t) => t.tool);
    expect(calls[0].resultSummary).toMatch(/invalid input/);
    expect(calls[1].resultSummary).toMatch(/finalize rejected: missing summary/);
    expect(calls[2].resultSummary).toMatch(/No evidence, no claim/);
    // No brief by turn 3: the loop injects a budget reminder.
    expect(state.trace.some((t) => t.label === "budget" && /^Budget reminder: \d+ turns and \d+s left/.test(t.thought))).toBe(true);
    expect(state.status).toBe("partial");
    expect(state.statusReason).toMatch(/3-turn limit/);
  });

  it("nudges once when the model stops without finalizing, then ends partial", async () => {
    const { ctx, state } = setup();
    const { client, requests } = fakeClient([[{ type: "text", text: "I think it's the DB." }]]);
    await runAgent(ctx, session(client), opts());

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages.at(-1))).toContain("finalize");
    expect(state.status).toBe("partial");
    expect(state.statusReason).toMatch(/without finalizing/);
  });

  it("refuses further investigation after the budget reminder until a brief exists", async () => {
    const { ctx, state } = setup();
    const { client } = fakeClient([
      [{ type: "tool_use", name: "get_changes", input: {} }],
      [{ type: "tool_use", name: "get_alerts", input: {} }],
      [{ type: "tool_use", name: "get_timeline", input: {} }], // turn 3: reminder fired; this must be refused
      [{ type: "tool_use", name: "update_investigation", input: completeBrief }],
      [{ type: "tool_use", name: "get_timeline", input: {} }], // brief exists: allowed again
      [{ type: "tool_use", name: "finalize", input: { rationale: "ok" } }],
    ]);
    await runAgent(ctx, session(client), opts());
    const calls = state.trace.filter((t) => t.tool);
    expect(calls[2]).toMatchObject({ tool: "get_timeline", resultSummary: "refused: out of time budget, brief must be written first" });
    expect(calls[4].resultSummary).toMatch(/events/);
    expect(state.status).toBe("complete");
    expect(state.briefSource).toBe("agent");
  });

  it("falls back to a deterministic pre-analysis brief when the agent writes none", async () => {
    const { ctx, state } = setup();
    let n = 0;
    const client = {
      messages: {
        create: async () => {
          if (n++ === 0) return { content: [{ type: "tool_use", id: "t1", name: "get_changes", input: {} }], stop_reason: "tool_use" };
          throw new Error("provider down");
        },
      },
    } as unknown as Anthropic;
    await runAgent(ctx, session(client), opts());

    expect(state.status).toBe("partial");
    expect(state.briefSource).toBe("pre-analysis");
    expect(state.summary).toMatch(/^The agent did not finish \(Model call failed.*provider down\)/);
    expect(state.hypotheses).toEqual([]); // no judgment from code
    expect(state.nextActions).toEqual([]);
    expect(state.keySignals.map((k) => k.evidenceId)).toEqual(expect.arrayContaining(["DEP-102", "CFG-502", "MET-orders_db.active_connections"]));
    expect(state.noise.map((k) => k.evidenceId)).toEqual(expect.arrayContaining(["ALR-001", "ALR-003"]));
    expect(state.openQuestions.at(-1)).toMatch(/Re-run/);
    // Everything it cites is real evidence.
    const exists = (id: string) => ctx.store.has(id);
    expect(checkGrounding({ summary: state.summary, impact: state.impact, timeline: state.timeline, keySignals: state.keySignals, noise: state.noise }, exists).unknownIds).toEqual([]);
  });

  it("rejects finalize once when Impact ignores the customer notes, naming them", async () => {
    const { ctx, state } = setup();
    const { client } = fakeClient([
      [{ type: "tool_use", name: "update_investigation", input: { ...completeBrief, impact: "Checkout errors (MET-checkout.error_rate_pct)." } }],
      [{ type: "tool_use", name: "finalize", input: { rationale: "done" } }],
      [{ type: "tool_use", name: "update_investigation", input: { impact: "87 tickets; some charged without an order (CUST-001, CUST-002)." } }],
      [{ type: "tool_use", name: "finalize", input: { rationale: "done" } }],
    ]);
    await runAgent(ctx, session(client), opts());
    const finals = state.trace.filter((t) => t.tool === "finalize").map((t) => t.resultSummary);
    expect(finals).toEqual(["finalize rejected: impact cites none of the customer notes", expect.stringMatching(/^finalized/)]);
    expect(state.status).toBe("complete");
  });

  it("keeps the best state when the model call fails mid-run", async () => {
    const { ctx, state } = setup();
    let n = 0;
    const client = {
      messages: {
        create: async () => {
          if (n++ === 0)
            return {
              content: [{ type: "tool_use", id: "t1", name: "update_investigation", input: { hypotheses: [goodHypothesis] } }],
              stop_reason: "tool_use",
            };
          throw new Error("boom");
        },
      },
    } as unknown as Anthropic;
    await runAgent(ctx, session(client), opts());
    expect(state.status).toBe("partial");
    expect(state.statusReason).toMatch(/boom/);
    expect(state.hypotheses).toHaveLength(1);
  });
});
