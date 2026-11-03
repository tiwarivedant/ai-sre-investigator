import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { followUpInvestigation, newInvestigationState } from "@/lib/investigation";
import { INVESTIGATIONS_DIR, saveInvestigation, loadInvestigation } from "@/lib/store";
import { AnthropicSession } from "@/lib/llm/anthropic";
import { toolSpecs } from "@/lib/tools";
import { diffBriefs } from "./revisions";
import type { Hypothesis, InvestigationState } from "@/lib/types";

const h = (over: Partial<Hypothesis>): Hypothesis => ({
  id: "H1", statement: "pool change", confidence: 0.85, status: "active", supporting: ["CFG-502"], contradicting: [], reasoning: "r", ...over,
});

describe("diffBriefs", () => {
  it("reports status, confidence, evidence, added/removed hypotheses and questions", () => {
    const before = { hypotheses: [h({}), h({ id: "H2", status: "rejected", confidence: 0.05 })], overallConfidence: 0.85, openQuestions: ["q1", "q2"], nextActions: [] };
    const after = {
      hypotheses: [h({ status: "confirmed", confidence: 0.97, supporting: ["CFG-502", "USER-001"] }), h({ id: "H3", statement: "new idea", confidence: 0.1 })],
      overallConfidence: 0.97,
      openQuestions: ["q2"],
      nextActions: [],
    };
    expect(diffBriefs(before, after)).toEqual([
      "H1 status active -> confirmed",
      "H1 confidence 85% -> 97%",
      "H1 new supporting evidence: USER-001",
      "H3 added (active, 10%): new idea",
      "H2 removed",
      "overall confidence 85% -> 97%",
      "open questions: 1 resolved, 0 new",
    ]);
  });
});

describe("followUpInvestigation", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const id of created) fs.rmSync(path.join(INVESTIGATIONS_DIR, `${id}.json`), { force: true });
  });

  it("stores the message as USER evidence, resumes the history, lets a human confirm, and records a revision", async () => {
    const state: InvestigationState = {
      ...newInvestigationState("checkout errors"),
      status: "complete",
      summary: "s", impact: "i", stakeholderUpdate: "u", overallConfidence: 0.85,
      timeline: [{ ts: "2026-10-28T13:52:00Z", evidenceId: "CFG-502", note: "pool" }],
      hypotheses: [h({})],
      openQuestions: ["Was CFG-502 intentional?"],
      nextActions: [{ action: "Revert pool", type: "config_revert", risk: "low", riskReason: "rubric", phase: "now", evidence: ["CFG-502"] }],
      trace: [{ step: 4, thought: "", tool: "finalize", ms: 1 }],
    };
    created.push(state.id);
    const priorHistory: Anthropic.MessageParam[] = [
      { role: "user", content: "initial" },
      { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "finalize", input: { rationale: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "{}" }] },
    ];
    saveInvestigation({ state, provider: "anthropic", model: "fake", history: priorHistory, userEvidence: [] });

    const turns = [
      [{ type: "tool_use", id: "t1", name: "update_investigation", input: {
        hypotheses: [h({ status: "confirmed", confidence: 0.97, supporting: ["CFG-502", "USER-001"] })],
        overallConfidence: 0.97,
        openQuestions: [],
        summary: "The inventory owner confirmed CFG-502 (USER-001); it exhausted orders-db connections.",
        impact: "Checkout errors (MET-checkout.error_rate_pct); 87 tickets (CUST-001).",
      } }],
      [{ type: "tool_use", id: "t2", name: "finalize", input: { rationale: "owner confirmed" } }],
    ];
    const requests: Anthropic.MessageCreateParams[] = [];
    let i = 0;
    const client = { messages: { create: async (p: Anthropic.MessageCreateParams) => {
      requests.push(structuredClone(p));
      return { content: turns[i++], stop_reason: "tool_use" };
    } } } as unknown as Anthropic;
    const session = new AnthropicSession({ system: "sys", tools: toolSpecs(), model: "fake", history: structuredClone(priorHistory) }, client);

    const out = await followUpInvestigation(state.id, "Marcus confirms he changed the pool", { session });

    // Resumed: the follow-up text is merged into the trailing tool-result turn, history intact.
    const firstReq = requests[0].messages;
    expect(firstReq).toHaveLength(3);
    expect(JSON.stringify(firstReq[2])).toContain("USER-001");
    expect(JSON.stringify(firstReq[2])).toContain("Marcus confirms");

    expect(out.status).toBe("complete");
    // Human-confirmed: "confirmed" allowed, but capped at 0.95 until a human reports recovery after the fix.
    expect(out.hypotheses[0]).toMatchObject({ status: "confirmed", confidence: 0.95 });
    expect(out.trace.find((t) => t.tool === "update_investigation")?.step).toBe(5); // numbering continues
    expect(out.revisions.at(-1)!.trigger).toBe("follow-up USER-001: Marcus confirms he changed the pool"); // no wrapping quotes
    expect(out.revisions.at(-1)!.changes).toContain("H1 status active -> confirmed");
    expect(out.revisions.at(-1)!.changes).toContain("H1 confidence 85% -> 95%");

    const reloaded = loadInvestigation(state.id)!;
    expect(reloaded.userEvidence.map((e) => e.id)).toEqual(["USER-001"]);
  });
});

describe("follow-up rewrite gate", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const id of created) fs.rmSync(path.join(INVESTIGATIONS_DIR, `${id}.json`), { force: true });
  });

  it("rejects finalize until summary and impact are rewritten", async () => {
    const state: InvestigationState = {
      ...newInvestigationState("checkout errors"),
      status: "complete",
      summary: "Likely CFG-502, not yet human-confirmed.", impact: "i", stakeholderUpdate: "u", overallConfidence: 0.85,
      timeline: [{ ts: "2026-10-28T13:52:00Z", evidenceId: "CFG-502", note: "pool" }],
      hypotheses: [h({})], openQuestions: ["q"],
      nextActions: [{ action: "Revert pool", type: "config_revert", risk: "low", riskReason: "rubric", phase: "now", evidence: ["CFG-502"] }],
    };
    created.push(state.id);
    saveInvestigation({ state, provider: "anthropic", model: "fake", history: [{ role: "user", content: "initial" }], userEvidence: [] });
    const turns = [
      [{ type: "tool_use", id: "a", name: "update_investigation", input: { hypotheses: [h({ status: "confirmed", supporting: ["CFG-502", "USER-001"] })] } }],
      [{ type: "tool_use", id: "b", name: "finalize", input: { rationale: "done" } }],
      [{ type: "tool_use", id: "c", name: "update_investigation", input: { summary: "The owner confirmed CFG-502 (USER-001) exhausted orders-db connections.", impact: "87 tickets (CUST-001)." } }],
      [{ type: "tool_use", id: "d", name: "finalize", input: { rationale: "done" } }],
    ];
    let i = 0;
    const client = { messages: { create: async () => ({ content: turns[i++], stop_reason: "tool_use" }) } } as unknown as Anthropic;
    const session = new AnthropicSession({ system: "s", tools: toolSpecs(), model: "fake", history: [{ role: "user", content: "initial" }] }, client);
    const out = await followUpInvestigation(state.id, "Marcus confirms", { session });

    const finals = out.trace.filter((t) => t.tool === "finalize").map((t) => t.resultSummary);
    expect(finals[0]).toMatch(/finalize rejected: missing summary.*impact/);
    expect(finals[1]).toMatch(/^finalized/);
    expect(out.status).toBe("complete");
    expect(out.consistencyIssues).toEqual([]);
  });
});

describe("key signals", () => {
  it("are not wiped by an update that sends an empty list", async () => {
    const { applyUpdate } = await import("@/lib/tools/stateTools");
    const state = { ...newInvestigationState("x"), keySignals: [{ evidenceId: "CFG-502", why: "pool raised", source: "agent" as const }] };
    applyUpdate(state, { keySignals: [] });
    expect(state.keySignals.map((k) => k.evidenceId)).toEqual(["CFG-502"]);
    applyUpdate(state, { keySignals: [{ evidenceId: "LOG-076", why: "pg_stat_activity" }] });
    expect(state.keySignals.map((k) => k.evidenceId)).toEqual(["LOG-076"]);
  });
});

describe("revisions", () => {
  it("record incident status changes", async () => {
    const { diffBriefs } = await import("./revisions");
    const base = { hypotheses: [], overallConfidence: 0.9, openQuestions: [], nextActions: [] };
    expect(diffBriefs({ ...base, incidentStatus: "identified" }, { ...base, incidentStatus: "mitigated" })).toEqual(["incident identified -> mitigated"]);
  });
});
