import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { listInvestigations, loadInvestigation, saveInvestigation, SAMPLES_DIR, INVESTIGATIONS_DIR } from "./store";
import { followUpInvestigation, newInvestigationState } from "./investigation";
import { AnthropicSession } from "./llm/anthropic";
import { toolSpecs } from "./tools";

const DIR = INVESTIGATIONS_DIR;
const forget = (id: string) => (globalThis as { __investigations?: Map<string, unknown> }).__investigations?.delete(id);

describe("samples", () => {
  // Uses its own temporary sample (built from the archived run), so it doesn't depend on what ships in samples/.
  const NAME = "zz-test-sample";
  const file = path.join(SAMPLES_DIR, `${NAME}.json`);
  const dirExisted = fs.existsSync(SAMPLES_DIR);
  beforeAll(() => {
    const src = JSON.parse(fs.readFileSync(path.join(process.cwd(), "notes/before-fixes/inv-20261102191424-c914d0.json"), "utf8"));
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...src, state: { ...src.state, id: `sample-${NAME}` }, history: [], sample: true, label: "Test sample" }));
  });
  afterAll(() => {
    fs.rmSync(file, { force: true });
    forget(`sample-${NAME}`);
    if (!dirExisted && fs.readdirSync(SAMPLES_DIR).length === 0) fs.rmdirSync(SAMPLES_DIR);
  });

  it("are listed separately and load as read-only", () => {
    const { samples, recent } = listInvestigations();
    const mine = samples.find((s) => s.id === `sample-${NAME}`)!;
    expect(mine).toMatchObject({ sample: true, followUps: 1, label: "Test sample" });
    expect(mine.topHypothesis).toMatchObject({ id: "H1", status: "confirmed" });
    expect(recent.some((s) => s.sample)).toBe(false);

    const inv = loadInvestigation(`sample-${NAME}`)!;
    expect(inv.sample).toBe(true);
    expect(inv.state.trace.length).toBeGreaterThan(0);
    expect(inv.userEvidence.map((e) => e.id)).toEqual(["USER-001"]);
    expect(() => saveInvestigation(inv)).toThrow(/read-only/);
  });

  it("cannot be followed up", async () => {
    await expect(followUpInvestigation(`sample-${NAME}`, "anything")).rejects.toThrow(/read-only sample/);
  });

  it("rejects ids that could escape the folders", () => {
    expect(loadInvestigation("sample-../../package")).toBeUndefined();
    expect(loadInvestigation("../package")).toBeUndefined();
  });
});

describe("saved investigations", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const id of created) {
      fs.rmSync(path.join(DIR, `${id}.json`), { force: true });
      forget(id);
    }
  });

  it("marks a run the server never finished as interrupted, so it can be followed up", () => {
    const state = { ...newInvestigationState("x"), status: "running" as const };
    created.push(state.id);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, `${state.id}.json`), JSON.stringify({ state, provider: "gemini", model: "m", history: [], userEvidence: [] }));
    const inv = loadInvestigation(state.id)!;
    expect(inv.state.status).toBe("partial");
    expect(inv.state.statusReason).toMatch(/Interrupted/);
  });

  it("resumes a follow-up from disk after a restart (nothing in memory)", async () => {
    const state = {
      ...newInvestigationState("checkout errors"),
      status: "complete" as const,
      summary: "s",
      impact: "i",
      stakeholderUpdate: "u",
      hypotheses: [{ id: "H1", statement: "pool", confidence: 0.85, status: "active" as const, supporting: ["CFG-502"], contradicting: [], reasoning: "r" }],
      timeline: [{ ts: "2026-10-28T13:52:00Z", evidenceId: "CFG-502", note: "pool" }],
      nextActions: [],
      openQuestions: ["q"],
    };
    created.push(state.id);
    const history: Anthropic.MessageParam[] = [
      { role: "user", content: "initial" },
      { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "finalize", input: { rationale: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "{}" }] },
    ];
    saveInvestigation({ state, provider: "anthropic", model: "fake", history, userEvidence: [] });
    forget(state.id); // simulate a server restart

    const seen: number[] = [];
    let i = 0;
    const turns = [
      [{ type: "tool_use", id: "t1", name: "update_investigation", input: { openQuestions: [] , summary: "updated" } }],
      [{ type: "tool_use", id: "t2", name: "finalize", input: { rationale: "ok" } }],
    ];
    const client = {
      messages: {
        create: async (p: Anthropic.MessageCreateParams) => {
          seen.push(p.messages.length);
          return { content: turns[i++], stop_reason: "tool_use" };
        },
      },
    } as unknown as Anthropic;
    const stored = loadInvestigation(state.id)!;
    const session = new AnthropicSession({ system: "s", tools: toolSpecs(), model: "fake", history: stored.history }, client);

    const out = await followUpInvestigation(state.id, "new info", { session });
    expect(seen[0]).toBe(3); // the saved conversation was resumed, with the follow-up merged into its last turn
    expect(out.summary).toBe("updated");
    expect(out.revisions).toHaveLength(1);
  });
});
