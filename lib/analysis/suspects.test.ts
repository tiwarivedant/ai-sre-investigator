import { describe, expect, it } from "vitest";
import { loadEvidenceStore } from "@/lib/evidence/loader";
import type { Hypothesis } from "@/lib/types";
import { runPreAnalysis } from "./preAnalysis";
import { responderTexts, suspectChanges, untestedSuspects } from "./suspects";

const hyp = (over: Partial<Hypothesis>): Hypothesis => ({
  id: "H1", statement: "s", confidence: 0.5, status: "active", supporting: [], contradicting: [], reasoning: "r", ...over,
});

describe("suspect changes", () => {
  it("marks changes in the window before onset, with responder mentions, and skips changes after onset", () => {
    const pa = runPreAnalysis(loadEvidenceStore());
    expect(pa.suspects).toEqual([
      { id: "DEP-102", reasons: ["in window (-8m before onset)", "named in CHAT-003"] },
      { id: "CFG-502", reasons: ["in window (-3m before onset)"] },
    ]);
    // DEP-103 (rollback to v2.13.4) and CFG-504 (payments_retry_on_timeout) are named in chat but came after onset.
    expect(pa.suspects.map((s) => s.id)).not.toContain("DEP-103");
    expect(pa.suspects.map((s) => s.id)).not.toContain("CFG-504");
  });

  it("adds an earlier change a responder names in the report or a follow-up (by ID, version or config key)", () => {
    const store = loadEvidenceStore();
    store.addUserEvidence("Could the holiday_banner flag be involved?");
    const { changes } = runPreAnalysis(store);
    const ids = (report?: string) => suspectChanges(changes, responderTexts(store.list(), report)).map((s) => s.id);
    expect(ids()).toContain("CFG-501");
    expect(ids("Search shipped v3.8.1 this morning, related?")).toContain("DEP-101");
    expect(ids("v3.8.10 is unrelated")).not.toContain("DEP-101"); // a version prefix is not a mention
  });

  it("is tested by a hypothesis that supports or rejects it, not by a contradicting citation", () => {
    const suspects = [{ id: "DEP-102", reasons: [] }, { id: "CFG-502", reasons: [] }];
    const pool = hyp({ supporting: ["CFG-502"], contradicting: ["DEP-102"] });
    expect(untestedSuspects(suspects, [pool])).toEqual(["DEP-102"]);
    expect(untestedSuspects(suspects, [pool, hyp({ id: "H2", status: "rejected", supporting: ["DEP-102"] })])).toEqual([]);
    expect(untestedSuspects(suspects, [pool, hyp({ id: "H2", status: "rejected", statement: "DEP-102 broke checkout" })])).toEqual([]);
  });
});
