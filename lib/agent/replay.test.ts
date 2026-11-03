import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { followUpInvestigation, newSession, startInvestigation } from "@/lib/investigation";
import { loadFixture, recordedFollowUps, ReplaySession } from "@/lib/llm/replay";
import { INVESTIGATIONS_DIR, loadInvestigation } from "@/lib/store";

// End-to-end regression over the recorded fixture (live Claude run inv-20261102195522-0f2da9:
// initial investigation + owner confirmation + recovery report + resolution). Real tools,
// grounding, policy, derivations and revisions; only the model is replayed. No network.
describe("replay fixture (inc-2213)", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const id of created) fs.rmSync(path.join(INVESTIGATIONS_DIR, `${id}.json`), { force: true });
  });

  it("reproduces the recorded investigation and its full incident lifecycle", async () => {
    const fixture = loadFixture("inc-2213");
    const state = await startInvestigation(fixture.incidentInput, { session: new ReplaySession(fixture, undefined, 0) });
    created.push(state.id);

    // Initial investigation: likely cause, red herring rejected, calibrated, history-aware.
    expect(state.status).toBe("complete");
    expect(state.incidentStatus).toBe("investigating");
    expect(state.groundingIssues).toEqual([]);
    expect(state.consistencyIssues).toEqual([]);
    expect(state.hypotheses[0]).toMatchObject({ status: "active", confidence: 0.85 });
    expect(state.hypotheses[0].supporting).toContain("CFG-502");
    expect(state.hypotheses.find((h) => h.supporting.includes("DEP-102"))?.status).toBe("rejected");
    expect(state.stakeholderUpdate).not.toMatch(/root cause/i);
    expect(state.openQuestions.length).toBeGreaterThan(0);
    expect(state.similarIncidents?.find((x) => x.incidentId === "INC-2041")?.hypothesisId).toBe("H1");
    expect(state.repeatIncident?.openActionItems).toEqual(["Add PgBouncer in front of orders-db", "Config-service guardrail on pool sizes"]);
    expect(state.contributingFactors?.filter((f) => f.source === "code").every((f) => f.evidence.includes("INC-2041"))).toBe(true);
    expect(state.timeline.find((t) => t.evidenceId === "DEP-102")?.kind).toBe("ruled-out");
    expect(state.overallConfidence).toBe(state.hypotheses[0].confidence);

    // Follow-ups, in order: each advances the incident one step.
    const expected = [
      { status: "identified", h1: "confirmed" },
      { status: "mitigated", h1: "confirmed" },
      { status: "resolved", h1: "confirmed" },
    ];
    const followUps = recordedFollowUps(fixture);
    expect(followUps).toHaveLength(3);
    for (const [i, message] of followUps.entries()) {
      const stored = loadInvestigation(state.id)!;
      expect(stored.provider).toBe("replay");
      const after = await followUpInvestigation(state.id, message, { session: new ReplaySession(fixture, stored.history, 0) });
      expect(after.status).toBe("complete");
      expect(after.incidentStatus).toBe(expected[i].status);
      expect(after.hypotheses[0].status).toBe(expected[i].h1);
      expect(after.consistencyIssues).toEqual([]);
      expect(after.revisions.at(-1)!.changes[0]).toMatch(/^incident \w+ -> \w+$/);
    }

    const final = loadInvestigation(state.id)!.state;
    expect(final.hypotheses[0]).toMatchObject({ status: "confirmed", confidence: 0.97 });
    expect(final.hypotheses[0].recoveryEvidence).toContain("USER-002");
    expect(final.doneActions?.map((d) => d.evidence)).toContainEqual(["USER-002"]); // the revert, reported done
    expect(final.revisions.map((r) => r.changes[0])).toEqual([
      "incident investigating -> identified",
      "incident identified -> mitigated",
      "incident mitigated -> resolved",
    ]);
    expect(final.timeline.filter((t) => t.kind === "follow-up").map((t) => t.evidenceId)).toEqual(["USER-001", "USER-002", "USER-003"]);
  });

  it("newSession('replay') loads the default fixture", () => {
    expect(newSession("replay").model).toBe("replay:inc-2213");
  });
});
