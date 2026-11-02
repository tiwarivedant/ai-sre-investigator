import { describe, expect, it } from "vitest";
import type { CorrelatedChange } from "@/lib/analysis/correlation";
import { applyPolicy, assessRisk, hedgeUnconfirmed, MAX_UNCONFIRMED_CONFIDENCE, missingOpenQuestions } from "./policy";
import type { InvestigationUpdate } from "./schemas";

type H = NonNullable<InvestigationUpdate["hypotheses"]>[number];
const hyp = (over: Partial<H>): H => ({
  id: "H1",
  statement: "s",
  confidence: 0.95,
  status: "confirmed",
  supporting: ["CFG-502"],
  contradicting: [],
  reasoning: "r",
  ...over,
});

const changes = [
  { id: "CFG-502", relation: "before_onset_in_window" },
  { id: "CFG-504", relation: "after_onset" },
  { id: "DEP-103", relation: "after_onset" },
] as CorrelatedChange[];

describe("confirmation and confidence", () => {
  it("downgrades 'confirmed' and caps confidence without human evidence", () => {
    const { update, adjustments } = applyPolicy({ hypotheses: [hyp({})], overallConfidence: 0.95 }, changes);
    expect(update.hypotheses![0]).toMatchObject({ status: "active", confidence: MAX_UNCONFIRMED_CONFIDENCE });
    expect(update.overallConfidence).toBe(MAX_UNCONFIRMED_CONFIDENCE);
    expect(adjustments).toHaveLength(3);
  });

  it("allows confirmation and high confidence when a human confirmed it (USER- evidence)", () => {
    const { update, adjustments } = applyPolicy(
      { hypotheses: [hyp({ supporting: ["CFG-502", "USER-001"] })], overallConfidence: 0.95 },
      changes,
    );
    expect(update.hypotheses![0]).toMatchObject({ status: "confirmed", confidence: 0.95 });
    expect(update.overallConfidence).toBe(0.95);
    expect(adjustments).toEqual([]);
  });

  it("leaves rejected hypotheses and in-range confidence alone", () => {
    const { update, adjustments } = applyPolicy(
      { hypotheses: [hyp({ status: "active", confidence: 0.7 }), hyp({ id: "H2", status: "rejected", confidence: 0.05 })] },
      changes,
    );
    expect(update.hypotheses!.map((h) => [h.status, h.confidence])).toEqual([["active", 0.7], ["rejected", 0.05]]);
    expect(adjustments).toEqual([]);
  });

  it("requires open questions at finalize only when nothing is confirmed", () => {
    expect(missingOpenQuestions({ hypotheses: [{ status: "active" }], openQuestions: [] })).toBe(true);
    expect(missingOpenQuestions({ hypotheses: [{ status: "active" }], openQuestions: ["q"] })).toBe(false);
    expect(missingOpenQuestions({ hypotheses: [{ status: "confirmed" }], openQuestions: [] })).toBe(false);
  });
});

describe("assessRisk", () => {
  it("follows the rubric", () => {
    expect(assessRisk("config_revert", "Revert DB_POOL_MAX to 20 in config-service").risk).toBe("low");
    expect(assessRisk("pod_restart", "Restart inventory-service pods").risk).toBe("medium");
    expect(assessRisk("db_change", "Raise max_connections").risk).toBe("high");
    expect(assessRisk("other", "Something").risk).toBe("medium");
  });

  it("escalates when the text describes a riskier operation than the type claims", () => {
    expect(assessRisk("config_revert", "Revert pool and restart inventory-service pods")).toMatchObject({ risk: "medium" });
    expect(assessRisk("investigate", "Terminate idle connections with pg_terminate_backend")).toMatchObject({ risk: "high" });
    expect(assessRisk("config_revert", "Increase max_connections on orders-db to 600").risk).toBe("high");
    expect(assessRisk("other", "Restart orders-db").risk).toBe("high");
  });

  it("does not escalate just because a DB-related setting is named", () => {
    expect(assessRisk("config_revert", "Revert inventory-service DB_POOL_MAX from 80 to 20").risk).toBe("low");
    expect(assessRisk("investigate", "Query pg_stat_activity on orders-db").risk).toBe("low");
  });
});

describe("after-recovery phasing", () => {
  const act = (action: string, evidence: string[], type: "flag_change" | "config_revert" = "flag_change") =>
    applyPolicy({ nextActions: [{ action, type, evidence }] }, changes);

  it("defers re-enabling a mitigation", () => {
    const r = act("Re-enable payments_retry_on_timeout", ["CFG-504"]);
    expect(r.nextActions![0].phase).toBe("after_recovery");
    expect(r.adjustments[0]).toMatch(/after-recovery/);
  });

  it("defers reverting a post-onset change even without 're-enable' wording", () => {
    expect(act("Revert CFG-504 so retries resume", ["CFG-504"]).nextActions![0].phase).toBe("after_recovery");
  });

  it("keeps fixing the cause as an immediate action", () => {
    const r = act("Restore inventory-service DB_POOL_MAX to 20 (revert CFG-502)", ["CFG-502"], "config_revert");
    expect(r.nextActions![0]).toMatchObject({ phase: "now", risk: "low" });
  });

  it("orders now-actions before after-recovery ones and sets risk on every action", () => {
    const { nextActions } = applyPolicy(
      {
        nextActions: [
          { action: "Re-enable the retry flag", type: "flag_change", evidence: ["CFG-504"] },
          { action: "Revert DB_POOL_MAX", type: "config_revert", evidence: ["CFG-502"] },
          { action: "Restart inventory pods if connections stay high", type: "pod_restart", evidence: ["CFG-502"] },
        ],
      },
      changes,
    );
    expect(nextActions!.map((a) => [a.phase, a.risk])).toEqual([
      ["now", "low"],
      ["now", "medium"],
      ["after_recovery", "low"],
    ]);
  });
});

describe("stakeholder wording", () => {
  it("softens certainty until a human confirms", () => {
    expect(hedgeUnconfirmed("We have identified the root cause of the errors.")).toBe("We have identified the likely cause of the errors.");
    expect(hedgeUnconfirmed("We have confirmed that a config change caused it.")).toBe("We believe that a config change caused it.");
    expect(hedgeUnconfirmed("The root cause is a pool change.")).toBe("The likely cause is a pool change.");
    expect(hedgeUnconfirmed("We are investigating the likely cause.")).toBeNull();
  });

  it("steps wording with the evidence: likely -> cause -> root cause", () => {
    const text = "We have confirmed the root cause.";
    // Nothing confirmed: "likely cause".
    expect(applyPolicy({ stakeholderUpdate: text }, changes, [{ status: "active" }]).update.stakeholderUpdate).toBe("We have identified the likely cause.");
    // Human-confirmed (also when hypotheses are unchanged in this update), recovery not verified: "the cause".
    expect(applyPolicy({ stakeholderUpdate: text }, changes, [{ status: "confirmed" }]).update.stakeholderUpdate).toBe("We have identified the cause.");
    const confirmedNow = applyPolicy({ stakeholderUpdate: text, hypotheses: [hyp({ supporting: ["USER-001"] })] }, changes);
    expect(confirmedNow.update.stakeholderUpdate).toBe("We have identified the cause.");
    // Recovery after the fix reported by a human: certainty allowed.
    const verified = applyPolicy({ stakeholderUpdate: text, hypotheses: [hyp({ supporting: ["USER-001"], recoveryEvidence: ["USER-002"] })] }, changes);
    expect(verified.update.stakeholderUpdate).toBe(text);
  });

  it("caps confirmed-but-unverified confidence at 0.95, and lifts the cap once recovery is reported", () => {
    const unverified = applyPolicy({ hypotheses: [hyp({ confidence: 1, supporting: ["USER-001"] })], overallConfidence: 1 }, changes);
    expect(unverified.update.hypotheses![0]).toMatchObject({ status: "confirmed", confidence: 0.95 });
    expect(unverified.update.overallConfidence).toBe(0.95);
    const verified = applyPolicy(
      { hypotheses: [hyp({ confidence: 1, supporting: ["USER-001"], recoveryEvidence: ["USER-002"] })], overallConfidence: 1 },
      changes,
    );
    expect(verified.update.hypotheses![0].confidence).toBe(1);
    expect(verified.update.overallConfidence).toBe(1);
    // Recovery evidence must come from a human, not telemetry.
    const notHuman = applyPolicy({ hypotheses: [hyp({ confidence: 1, supporting: ["USER-001"], recoveryEvidence: ["MET-checkout.error_rate_pct"] })] }, changes);
    expect(notHuman.update.hypotheses![0].confidence).toBe(0.95);
  });
});

describe("non-changing actions", () => {
  it("are low risk even when they mention a rollback or restart", () => {
    expect(assessRisk("investigate", "Ask Dana what evidence links v2.14.0 to the errors, given the rollback at 14:18 did not fix them")).toEqual({
      risk: "low",
      riskReason: 'rubric: "ask" changes nothing = low',
    });
    expect(assessRisk("communicate", "Notify the IC that restarting the pods is not needed").risk).toBe("low");
    expect(assessRisk("investigate", "Confirm whether the rollback DEP-103 completed").risk).toBe("low");
  });

  it("still escalates actions that change things", () => {
    expect(assessRisk("other", "Roll back payments-service to v2.13.4").risk).toBe("medium");
    expect(assessRisk("config_revert", "Revert the pool and restart inventory pods").risk).toBe("medium");
  });
});
