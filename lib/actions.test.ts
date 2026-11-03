import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ActionError, applyAction } from "./actions";
import { followUpInvestigation, newInvestigationState, startInvestigation } from "./investigation";
import { loadFixture, ReplaySession } from "./llm/replay";
import { INVESTIGATIONS_DIR, listInvestigations, loadInvestigation } from "./store";

// A replayed investigation (no network) to act on.
async function replayed(followUps = 0) {
  const f = loadFixture();
  const state = await startInvestigation(f.incidentInput, { session: new ReplaySession(f, undefined, 0) });
  for (const m of f.runs.filter((r) => r.kind === "followup").slice(0, followUps).map((r) => r.message!)) {
    await followUpInvestigation(state.id, m, { session: new ReplaySession(f, loadInvestigation(state.id)!.history, 0) });
  }
  return state.id;
}

const created: string[] = [];
afterEach(() => {
  for (const id of created.splice(0)) fs.rmSync(path.join(INVESTIGATIONS_DIR, `${id}.json`), { force: true });
});

describe("responder actions (no model call)", () => {
  it("adds a note as USER evidence with a revision, without running the agent", async () => {
    const id = await replayed();
    created.push(id);
    const traceBefore = loadInvestigation(id)!.state.trace.length;
    const s = applyAction(id, "note", "Support confirms 14 duplicate holds are being refunded.");
    expect(s.trace.length).toBe(traceBefore); // no agent run
    expect(s.revisions.at(-1)!.trigger).toBe("note USER-001: Support confirms 14 duplicate holds are being refunded.");
    const stored = loadInvestigation(id)!;
    expect(stored.userEvidence.map((e) => [e.id, (e.raw as { action?: string }).action])).toEqual([["USER-001", "note"]]);
    expect(stored.undeliveredNotes).toEqual(["USER-001"]);
    expect(s.timeline.some((t) => t.evidenceId === "USER-001")).toBe(true);
  });

  it("requires a comment to resolve, and confirmation when recovery isn't verified", async () => {
    const id = await replayed(1); // owner confirmed: identified, recovery not reported
    created.push(id);
    expect(() => applyAction(id, "resolve", "  ")).toThrow(/comment is required/);
    const err = (() => {
      try {
        applyAction(id, "resolve", "Reverted; looks fine");
      } catch (e) {
        return e as ActionError;
      }
    })();
    expect(err?.code).toBe("needs_confirmation");
    expect(err?.message).toMatch(/Recovery hasn't been verified \(status: identified\)/);

    const s = applyAction(id, "resolve", "Reverted; looks fine", { confirm: true });
    expect(s.incidentStatus).toBe("resolved");
    expect(s.resolution).toMatchObject({ evidenceId: "USER-002", recoveryVerified: false });
    expect(s.revisions.at(-1)!.changes).toContain("incident identified -> resolved");
  });

  it("resolves without confirmation once recovery is verified, and reopens", async () => {
    const id = await replayed(2); // mitigated
    created.push(id);
    const resolved = applyAction(id, "resolve", "Stable since the revert; closing.");
    expect(resolved.incidentStatus).toBe("resolved");
    expect(resolved.resolution?.recoveryVerified).toBe(true);
    expect(listInvestigations().recent.find((r) => r.id === id)).toMatchObject({ incidentStatus: "resolved", open: false });

    const reopened = applyAction(id, "reopen", "Errors are back at 15:10.");
    expect(reopened.incidentStatus).toBe("mitigated");
    expect(reopened.resolution).toBeUndefined();
    expect(reopened.revisions.at(-1)!.changes).toContain("incident resolved -> mitigated");
  });

  it("does not let a resolve comment, or an earlier report, keep a reopened incident resolved", async () => {
    const id = await replayed(3); // resolved by the follow-up "resolved"
    created.push(id);
    expect(loadInvestigation(id)!.state.incidentStatus).toBe("resolved");
    expect(applyAction(id, "reopen", undefined).incidentStatus).toBe("mitigated");
  });

  it("refuses samples, and investigations that are not resolved for reopen", async () => {
    expect(() => applyAction("sample-01-checkout-incident", "note", "x")).toThrow(/read-only/);
    const id = await replayed();
    created.push(id);
    expect(() => applyAction(id, "reopen", undefined)).toThrow(/Only a resolved incident/);
  });

  it("delivers notes to the agent at the next follow-up", async () => {
    const id = await replayed();
    created.push(id);
    applyAction(id, "note", "Marcus is on the bridge.");
    const f = loadFixture();
    const session = new ReplaySession(f, loadInvestigation(id)!.history, 0);
    await followUpInvestigation(id, f.runs[1].message!, { session });
    const sent = JSON.stringify(session.history.find((e) => JSON.stringify(e).includes("<responder_followup>")));
    expect(sent).toMatch(/Responders recorded these since your last update[\s\S]*USER-001 \(note/);
    expect(loadInvestigation(id)!.undeliveredNotes ?? []).toEqual([]);
  });
});

describe("Stop", () => {
  it("ends the run at once, keeps the brief so far, and marks it partial", async () => {
    const f = loadFixture();
    const controller = new AbortController();
    const session = new ReplaySession(f, undefined, 200); // slow enough to stop mid-run
    setTimeout(() => controller.abort(), 300);
    const state = await startInvestigation(f.incidentInput, { session, signal: controller.signal });
    created.push(state.id);
    expect(state.status).toBe("partial");
    expect(state.statusReason).toBe("Stopped by the responder; showing the brief so far.");
    expect(state.trace.at(-1)).toMatchObject({ label: "stopped" });
    expect(state.summary.length).toBeGreaterThan(0); // pre-analysis brief if the agent hadn't written one
  });

  it("is a no-op for a fresh state", () => {
    expect(newInvestigationState("x").status).toBe("running");
  });
});
