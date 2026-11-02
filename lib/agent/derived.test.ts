import { describe, expect, it } from "vitest";
import { buildContext, newInvestigationState } from "@/lib/investigation";
import fs from "node:fs";
import path from "node:path";
import { applyPolicy, splitCompound } from "./policy";
import { consistencyIssues, refreshDerived } from "./derived";
import type { Hypothesis, InvestigationState } from "@/lib/types";

/** The archived pre-fix live run (committed under notes/) and an extract of the post-fix one. */
const beforeFixes = JSON.parse(fs.readFileSync(path.join(process.cwd(), "notes/before-fixes/inv-20261102191424-c914d0.json"), "utf8")).state as InvestigationState;
const afterFixes = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "testdata/claude-after-fixes-brief.json"), "utf8")) as Partial<InvestigationState>;

const h = (over: Partial<Hypothesis>): Hypothesis => ({
  id: "H1", statement: "inventory pool change exhausted orders-db connections", confidence: 0.85, status: "active",
  supporting: ["CFG-502"], contradicting: [], reasoning: "pool budget 610 vs 400 max connections", ...over,
});

function derive(over: Partial<InvestigationState>) {
  const state = { ...newInvestigationState("x"), ...over };
  const ctx = buildContext(state);
  refreshDerived(state, ctx.pa, ctx.store);
  return state;
}

describe("timeline times come from the evidence", () => {
  it("ignores model-written times, uses change-points for metrics, and drops timeless entries", () => {
    const s = derive({
      timeline: [
        { ts: "13:52", evidenceId: "CFG-502", note: "pool raised" },
        { ts: "garbage", evidenceId: "MET-orders_db.active_connections", note: "connections climb" },
        { ts: "", evidenceId: "RB-postgres-connection-exhaustion", note: "runbook" },
        { ts: "2026-10-28T09:00:00Z", evidenceId: "LOG-076", note: "pg_stat_activity" },
      ],
    });
    expect(s.timeline.map((t) => [t.evidenceId, t.ts])).toEqual([
      ["CFG-502", "2026-10-28T13:52:00Z"],
      ["MET-orders_db.active_connections", "2026-10-28T13:55:00Z"],
      ["LOG-076", "2026-10-28T14:11:00Z"],
    ]);
  });
});

describe("noise", () => {
  it("always includes code-flagged noise; the agent can re-word or override with a reason", () => {
    const s = derive({
      noise: [{ evidenceId: "ALR-001", why: "log host disk, rotates nightly" }],
      notNoise: [{ evidenceId: "ALR-011", why: "reporting job adds connections to orders-db" }],
    });
    const ids = s.noise.map((n) => [n.evidenceId, n.source]);
    expect(ids).toContainEqual(["ALR-001", "agent"]);
    expect(ids).toEqual(expect.arrayContaining([["ALR-002", "code"], ["ALR-003", "code"], ["ALR-013", "code"]]));
    expect(s.noise.find((n) => n.evidenceId === "ALR-001")!.why).toBe("log host disk, rotates nightly");
    expect(ids.map((x) => x[0])).not.toContain("ALR-011");
  });
});

describe("similar incidents and repeat detection", () => {
  it("gives an active hypothesis its top match even when the runner-up is close", () => {
    // Hypotheses from the archived live run where INC-2041 (8.4) only narrowly beat INC-1987 (6.1) and was dropped.
    const s = derive({ hypotheses: structuredClone(beforeFixes.hypotheses) });
    expect(s.similarIncidents?.find((x) => x.incidentId === "INC-2041")?.hypothesisId).toBe("H1");
    expect(s.repeatIncident?.openActionItems).toEqual(["Add PgBouncer in front of orders-db", "Config-service guardrail on pool sizes"]);
    expect(s.nextActions.filter((a) => a.phase === "prevention").map((a) => a.priority)).toEqual(["P1", "P1"]);
  });
});

describe("consistency check", () => {
  it("flags summary text that contradicts hypothesis status", () => {
    const confirmed = { ...newInvestigationState("x"), hypotheses: [h({ status: "confirmed" as const, supporting: ["CFG-502", "USER-001"] })] };
    expect(consistencyIssues({ ...confirmed, summary: "High confidence, not human-confirmed." })).toEqual([
      "summary says the cause is unconfirmed, but H1 is confirmed",
    ]);
    const active = { ...newInvestigationState("x"), hypotheses: [h({}), h({ id: "H2", status: "rejected" as const, supporting: ["DEP-102"] })] };
    expect(consistencyIssues({ ...active, summary: "We have confirmed the cause." })).toEqual(["summary claims confirmation, but no hypothesis is human-confirmed"]);
    expect(consistencyIssues({ ...active, summary: "Errors were caused by DEP-102." })).toEqual([
      "summary attributes the cause to DEP-102, but H2 (which it supports) is rejected",
    ]);
    expect(consistencyIssues({ ...active, summary: "Likely CFG-502; DEP-102 was ruled out." })).toEqual([]);
  });
});

describe("actions", () => {
  it("splits compound actions so each operation gets its own risk", () => {
    const { nextActions } = applyPolicy(
      { nextActions: [{ action: "Revert inventory-service DB_POOL_MAX to 20 and roll the pods, then watch orders-db connections", type: "config_revert", evidence: ["CFG-502"] }] },
      [],
    );
    expect(nextActions!.map((a) => [a.action, a.type, a.risk])).toEqual([
      ["Revert inventory-service DB_POOL_MAX to 20", "config_revert", "low"],
      ["Roll the pods", "pod_restart", "medium"],
      ["Watch orders-db connections", "investigate", "low"],
    ]);
    expect(splitCompound("Check pods and services on orders-db")).toEqual(["Check pods and services on orders-db"]);
  });

  it("prioritises prevention instead of risk-rating it", () => {
    const { nextActions } = applyPolicy(
      { nextActions: [{ action: "Add PgBouncer and a guardrail on pool-size changes (budget check against max_connections)", type: "prevention", phase: "prevention", evidence: ["INC-2041"] }] },
      [],
    );
    expect(nextActions![0]).toMatchObject({ phase: "prevention", priority: "P2", riskReason: "not risk-rated: planned post-incident work" });
  });
});

describe("prevention dedupe", () => {
  it("does not add a code item the agent already wrote in its own words", () => {
    const s = derive({
      hypotheses: structuredClone(beforeFixes.hypotheses),
      nextActions: [
        { action: "Deploy PgBouncer in front of orders-db", type: "prevention", phase: "prevention", risk: "low", riskReason: "", evidence: ["INC-2041"], source: "agent" },
        { action: "Add guardrail validating summed pool budgets against max_connections", type: "prevention", phase: "prevention", risk: "low", riskReason: "", evidence: ["INC-2041"], source: "agent" },
      ],
    });
    const prevention = s.nextActions.filter((a) => a.phase === "prevention");
    expect(prevention.map((a) => [a.source, a.priority])).toEqual([
      ["agent", "P1"],
      ["agent", "P1"],
    ]);
  });
});

describe("unexplained signals", () => {
  it("treats a service the summary says is affected as covered", () => {
    // Live Claude run: the summary says "...failing checkout" but cites no checkout evidence ID,
    // and the agent explained the payments latency as a retry symptom (key signal LOG-046).
    const s = derive(structuredClone(afterFixes));
    expect(s.unexplained).toEqual([]);
    // Without the agent's LOG-046 explanation, the payments bump is flagged again.
    const noRetryExplanation = derive({ ...structuredClone(afterFixes), keySignals: afterFixes.keySignals!.filter((k) => k.evidenceId !== "LOG-046") });
    expect(noRetryExplanation.unexplained?.map((u) => u.evidenceId)).toEqual(["MET-payments.p95_latency_ms"]);
  });
});
