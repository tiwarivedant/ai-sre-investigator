import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { followUpInvestigation, newSession, startInvestigation } from "@/lib/investigation";
import { loadFixture, ReplaySession } from "@/lib/llm/replay";
import { loadInvestigation } from "@/lib/store";

// End-to-end regression over the recorded fixture: real tools, grounding,
// policy and revisions; only the model is replayed. No network, no API key.
describe("replay fixture (inc-2213)", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const id of created) fs.rmSync(path.join(process.cwd(), ".investigations", `${id}.json`), { force: true });
  });

  it("reproduces the recorded investigation and follow-up", async () => {
    const fixture = loadFixture("inc-2213");
    const session = new ReplaySession(fixture, undefined, 0);
    const state = await startInvestigation(fixture.incidentInput, { session });
    created.push(state.id);

    expect(state.status).toBe("complete");
    expect(state.groundingIssues).toEqual([]);
    expect(state.hypotheses[0]).toMatchObject({ status: "active", confidence: 0.85 });
    expect(state.hypotheses[0].supporting).toContain("CFG-502");
    expect(state.hypotheses.find((h) => h.supporting.includes("DEP-102"))?.status).toBe("rejected");
    expect(state.openQuestions.length).toBeGreaterThan(0);
    expect(state.nextActions.find((a) => /retry/i.test(a.action))?.phase).toBe("after_recovery");
    // Calibrated comms, prior-incident memory, and the coverage check.
    expect(state.stakeholderUpdate).toMatch(/likely cause/);
    expect(state.stakeholderUpdate).not.toMatch(/root cause/i);
    expect(state.similarIncidents?.find((x) => x.incidentId === "INC-2041")).toMatchObject({ hypothesisId: "H1", source: "retrieval" });
    expect(state.similarIncidents?.[0].similarity).toMatch(/raised its DB pool/);
    expect(state.similarIncidents?.[0].lesson).toMatch(/30 minutes lost investigating the most recent deploy/);
    expect(state.unexplained?.map((u) => u.evidenceId)).toEqual(["MET-payments.p95_latency_ms"]);
    // The data that explains it is surfaced for a human, not claimed by code.
    expect(state.unexplained?.[0].related.map((r) => r.evidenceId)).toEqual(expect.arrayContaining(["ALR-009", "LOG-046", "CFG-504"]));
    // Repeat incident: INC-2041's safeguards were never built.
    expect(state.repeatIncident).toEqual({
      incidentId: "INC-2041",
      hypothesisId: "H1",
      openActionItems: ["Add PgBouncer in front of orders-db", "Config-service guardrail on pool sizes"],
    });
    expect(state.contributingFactors?.map((f) => f.evidence)).toEqual([["INC-2041"], ["INC-2041"], ["CFG-502", "INC-2041"]]);
    expect(state.nextActions.filter((a) => a.phase === "prevention").map((a) => [a.source, a.risk])).toEqual([
      ["code", "low"],
      ["code", "low"],
    ]);
    expect(state.trace.find((t) => t.label === "budget")?.thought).toMatch(/^Budget reminder: \d+ turns and \d+s left/);

    const stored = loadInvestigation(state.id)!;
    expect(stored.provider).toBe("replay");
    const followSession = new ReplaySession(fixture, stored.history, 0);
    const events: { type: string; revisions: number }[] = [];
    const after = await followUpInvestigation(state.id, fixture.runs[1].message!, {
      session: followSession,
      onEvent: (e) => e.type !== "trace" && events.push({ type: e.type, revisions: e.state.revisions.length }),
    });
    // "done" is emitted exactly once, after the revision exists (the UI's "What changed" banner depends on it).
    expect(events.filter((e) => e.type === "done")).toEqual([{ type: "done", revisions: 1 }]);
    expect(after.hypotheses[0].status).toBe("confirmed");
    // Human-confirmed but recovery not yet verified: 95% and "the cause", not "the root cause".
    expect(after.hypotheses[0].confidence).toBe(0.95);
    expect(after.overallConfidence).toBe(0.95);
    expect(after.stakeholderUpdate).toMatch(/identified the cause/);
    expect(after.stakeholderUpdate).not.toMatch(/root cause/i);
    // The follow-up sits on the real clock, after every incident event.
    const userEntry = after.timeline.find((t) => t.evidenceId === "USER-001")!;
    expect(userEntry.ts > "2026-10-29").toBe(true);
    expect(after.timeline.at(-1)!.evidenceId).toBe("USER-001");
    expect(after.revisions.at(-1)!.changes).toContain("H1 status active -> confirmed");
  });

  it("newSession('replay') loads the default fixture", () => {
    expect(newSession("replay").model).toBe("replay:inc-2213");
  });
});
