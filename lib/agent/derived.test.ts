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

/** Live run with two follow-ups (owner confirmation, then recovery after the revert). */
const run = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "testdata/claude-two-followups-brief.json"), "utf8"));
function deriveRun(over: Partial<InvestigationState> = {}, extraUserText?: string): InvestigationState {
  const state = { ...newInvestigationState("x"), ...structuredClone(run), ...over } as InvestigationState;
  const ctx = buildContext(state);
  for (const e of run.userEvidence) ctx.store.add(e);
  if (extraUserText) ctx.store.addUserEvidence(extraUserText, "2026-11-02T20:00:00Z");
  refreshDerived(state, ctx.pa, ctx.store);
  return state;
}

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
    // DEP-102 is not listed by the model, but deploys/config changes in the window before onset always appear.
    expect(s.timeline.map((t) => [t.evidenceId, t.ts])).toEqual([
      ["DEP-102", "2026-10-28T13:40:00Z"],
      ["CFG-502", "2026-10-28T13:52:00Z"],
      ["MET-orders_db.active_connections", "2026-10-28T13:55:00Z"],
      ["LOG-076", "2026-10-28T14:11:00Z"],
    ]);
    expect(s.timeline.find((t) => t.evidenceId === "CFG-502")!.note).toBe("pool raised");
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
    // Without the agent's LOG-046 explanation (key signal and the H1 reasoning that cites it), it is flagged again.
    const stripped = structuredClone(afterFixes);
    stripped.keySignals = stripped.keySignals!.filter((k) => k.evidenceId !== "LOG-046");
    stripped.hypotheses = stripped.hypotheses!.map((x) => ({ ...x, reasoning: x.reasoning.replace(/\(?LOG-046\)?/g, "") }));
    const noRetryExplanation = derive(stripped);
    expect(noRetryExplanation.unexplained?.map((u) => u.evidenceId)).toEqual(["MET-payments.p95_latency_ms"]);
  });
});

describe("live run with two follow-ups (owner confirmation, then recovery)", () => {

  it("derives key signals from the leading hypothesis when the agent wrote none", () => {
    const s = deriveRun();
    expect(s.keySignals.length).toBeGreaterThan(0);
    expect(s.keySignals.every((k) => k.source === "code")).toBe(true);
    expect(s.keySignals.map((k) => k.evidenceId)).toEqual(s.hypotheses[0].supporting.slice(0, 6));
    const metric = deriveRun({ hypotheses: [{ ...run.hypotheses[0], supporting: ["MET-orders_db.active_connections", ...run.hypotheses[0].supporting] }, run.hypotheses[1]] });
    expect(metric.keySignals[0].why).toMatch(/^Rose 244\.5 -> 331/);
    expect(metric.timeline.find((t) => t.evidenceId === "MET-orders_db.active_connections")!.note).toMatch(/^Rose/);
    // A second refresh must not keep a stale code-written note (only agent notes carry over).
    const ctx = buildContext(metric);
    for (const e of run.userEvidence) ctx.store.add(e);
    metric.timeline = metric.timeline.map((t) => (t.evidenceId.startsWith("MET-") ? { ...t, note: "Metric stale title" } : t));
    refreshDerived(metric, ctx.pa, ctx.store);
    expect(metric.timeline.find((t) => t.evidenceId === "MET-orders_db.active_connections")!.note).toMatch(/^Rose/);
  });

  it("builds the timeline from all cited evidence plus follow-ups and the red-herring deploy, without times in notes", () => {
    const s = deriveRun();
    const ids = s.timeline.map((t) => t.evidenceId);
    expect(ids).toEqual(expect.arrayContaining(["DEP-102", "CFG-502", "LOG-076", "USER-001", "USER-002"]));
    expect(s.timeline.filter((t) => t.kind === "follow-up").map((t) => t.evidenceId)).toEqual(["USER-001", "USER-002"]);
    expect(s.timeline.find((t) => t.evidenceId === "DEP-102")!.kind).toBe("ruled-out");
    expect(s.timeline.every((t) => !/^\s*\d{1,2}:\d{2}/.test(t.note))).toBe(true);
    expect([...s.timeline].sort((a, b) => a.ts.localeCompare(b.ts))).toEqual(s.timeline);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses one confidence rule: overall = the leading hypothesis's confidence", () => {
    const s = deriveRun({ overallConfidence: 0.5 });
    expect(s.overallConfidence).toBe(s.hypotheses[0].confidence);
  });

  it("marks the incident mitigated after reported recovery, and adds the closing actions", () => {
    const s = deriveRun();
    expect(s.incidentStatus).toBe("mitigated");
    const code = s.nextActions.filter((a) => a.source === "code");
    expect(code.find((a) => /^Monitor error rate.*30 minutes.*resolve the incident/.test(a.action))?.phase).toBe("now");
    expect(code.find((a) => /^Schedule the postmortem/.test(a.action))).toMatchObject({ phase: "prevention", priority: "P1" });
  });

  it("marks it resolved once a human reports it held, and drops the monitor step", () => {
    const s = deriveRun({}, "Error rate stable for 30 minutes after the revert; resolving the incident.");
    expect(s.incidentStatus).toBe("resolved");
    expect(s.nextActions.some((a) => /^Monitor error rate/.test(a.action))).toBe(false);
    expect(s.nextActions.some((a) => /postmortem/.test(a.action))).toBe(true);
  });

  it("keeps the agent's noise reason and shows the heuristic flags with it", () => {
    const s = deriveRun({ noise: [{ evidenceId: "ALR-001", why: "log host disk; rotates nightly", source: "agent" }] });
    const alr1 = s.noise.find((n) => n.evidenceId === "ALR-001")!;
    expect(alr1).toMatchObject({ why: "log host disk; rotates nightly", source: "agent" });
    expect(alr1.flags).toEqual(expect.arrayContaining(["outside blast radius"]));
    expect(s.noise.find((n) => n.evidenceId === "ALR-002")).toMatchObject({ source: "code" });
  });
});

describe("incident status", () => {
  it("is investigating until a human confirms, identified until recovery is reported", () => {
    expect(derive({ hypotheses: [h({})] }).incidentStatus).toBe("investigating");
    expect(derive({ hypotheses: [h({ status: "confirmed", supporting: ["CFG-502", "USER-001"] })] }).incidentStatus).toBe("identified");
  });
});

describe("timeline notes", () => {
  it("strip a leading time but leave identifiers alone", async () => {
    const { stripLeadingTime } = await import("./derived");
    expect(stripLeadingTime("13:52 inventory pool 20->80")).toBe("Inventory pool 20->80");
    expect(stripLeadingTime("14:03 onward: spike in errors")).toBe("Spike in errors");
    expect(stripLeadingTime("payments.p95_latency_ms rose 416 -> 640")).toBe("payments.p95_latency_ms rose 416 -> 640");
  });

  it("tag the red-herring deploy as ruled out even when live reasoning names it to dismiss it", () => {
    const s = derive({
      hypotheses: [
        h({ status: "confirmed", supporting: ["CFG-502", "USER-001"], reasoning: "Not the payments deploy (DEP-102): the rollback did not help." }),
        h({ id: "H2", status: "rejected", supporting: ["DEP-102"], statement: "payments deploy" }),
      ],
    });
    expect(s.timeline.find((t) => t.evidenceId === "DEP-102")!.kind).toBe("ruled-out");
  });
});

describe("done actions", () => {
  it("detects actions a follow-up reports as done (past-tense verb + same specific thing)", async () => {
    const { satisfiedBy } = await import("./derived");
    const ups = [{ id: "USER-002", text: "Reverted DB_POOL_MAX to 20 at 14:35. orders-db connections back to 250." }];
    expect(satisfiedBy("Revert inventory-service DB_POOL_MAX to 20 (CFG-502)", ups)).toEqual(["USER-002"]);
    expect(satisfiedBy("Revert payments_retry_on_timeout", ups)).toEqual([]); // different thing
    expect(satisfiedBy("Monitor DB_POOL_MAX for 30 minutes", ups)).toEqual([]); // ongoing, not one-off
    expect(satisfiedBy("Re-enable payments_retry_on_timeout", [{ id: "USER-003", text: "We re-enabled payments_retry_on_timeout." }])).toEqual(["USER-003"]);
    expect(satisfiedBy("Roll back payments-service to v2.13.4", [{ id: "USER-004", text: "rolled back payments-service" }])).toEqual(["USER-004"]);
  });

  it("moves them from next actions to Done, citing the follow-up", () => {
    const revert = { action: "Revert inventory-service DB_POOL_MAX to 20 (CFG-502)", type: "config_revert" as const, risk: "low" as const, riskReason: "", phase: "now" as const, evidence: ["CFG-502"], source: "agent" as const };
    const s = deriveRun({ nextActions: [revert, ...run.nextActions] });
    expect(s.nextActions.some((a) => a.action === revert.action)).toBe(false);
    expect(s.doneActions).toContainEqual({ action: revert.action, evidence: ["USER-002"], source: "code" });
  });
});

describe("contributing factors and prevention citations", () => {
  it("always include the code-derived factors (citing INC-2041), dropping agent duplicates", () => {
    const s = deriveRun({
      contributingFactors: [
        { factor: "No pooler on orders-db; INC-2041 action item still open", evidence: ["CFG-502"], source: "agent" },
        { factor: "Config changes not on deploy dashboard", evidence: ["CFG-502"], source: "agent" },
        { factor: "FALL25 promo raised traffic about 10%", evidence: ["CUST-003"], source: "agent" },
      ],
    });
    const code = s.contributingFactors!.filter((f) => f.source === "code");
    expect(code.length).toBe(3);
    expect(code.every((f) => f.evidence.includes("INC-2041"))).toBe(true);
    expect(s.contributingFactors!.filter((f) => f.source === "agent").map((f) => f.factor)).toEqual(["FALL25 promo raised traffic about 10%"]);
  });

  it("make agent prevention items that cover an INC-2041 item cite INC-2041", () => {
    const s = deriveRun({
      nextActions: [{ action: "Deploy PgBouncer", type: "prevention", risk: "low", riskReason: "", phase: "prevention", priority: "P2", evidence: ["CFG-502"], source: "agent" }],
    });
    expect(s.nextActions.find((a) => a.action === "Deploy PgBouncer")).toMatchObject({ priority: "P1", evidence: ["INC-2041", "CFG-502"] });
  });
});

describe("noise reason shown once", () => {
  it("stores only flags for code-flagged noise", () => {
    const s = deriveRun();
    const alr2 = s.noise.find((n) => n.evidenceId === "ALR-002")!;
    expect(alr2.why).toBe("");
    expect(alr2.flags).toEqual(["not in catalog", "preceded onset"]);
  });
});

describe("impact onset", () => {
  it("is flagged when it doesn't match the metric change-point", () => {
    expect(deriveRun({ impact: "Checkout errors from about 14:03 until the revert (CUST-001)." }).consistencyIssues).toContain(
      "impact gives the start as 14:03, but the metrics changed at 13:55 UTC (use the metric onset)",
    );
    expect(deriveRun({ impact: "Checkout errors from 13:55 until the revert; tickets spiked from 14:03 (CUST-001)." }).consistencyIssues).toEqual([]);
  });
});

describe("recovery reports (read from the human's words)", () => {
  async function reportsFor(texts: string[]) {
    const { recoveryReports } = await import("./derived");
    const ctx = buildContext(newInvestigationState("x"));
    texts.forEach((t) => ctx.store.addUserEvidence(t));
    return recoveryReports(ctx.store);
  }

  it("recognises recovery wording and ignores negations", async () => {
    expect(await reportsFor(["Reverted DB_POOL_MAX to 20 at 14:35. orders-db connections back to 250, checkout errors at 0.3%."])).toEqual(["USER-001"]);
    expect(await reportsFor(["Checkout error rate down to 0.3% after the revert"])).toEqual(["USER-001"]);
    expect(await reportsFor(["Service restored at 14:40"])).toEqual(["USER-001"]);
    expect(await reportsFor(["Marcus confirms he changed DB_POOL_MAX from 20 to 80 at 13:52."])).toEqual([]);
    expect(await reportsFor(["Reverted, but errors are not back to normal yet"])).toEqual([]);
    expect(await reportsFor(["Still not recovered"])).toEqual([]);
    expect(await reportsFor(["resolved"])).toEqual([]); // resolution, not a recovery report
  });

  it("marks the incident mitigated when the agent cites the recovery report only as support (live run 1b51dd)", () => {
    // After USER-002 the agent added it to H1.supporting but did not set recoveryEvidence.
    const hyps = structuredClone(run.hypotheses).map((x: Hypothesis) => ({ ...x, recoveryEvidence: undefined }));
    const s = deriveRun({ hypotheses: hyps });
    expect(s.hypotheses[0].recoveryEvidence).toEqual(["USER-002"]);
    expect(s.incidentStatus).toBe("mitigated");
  });

  it("lifts the 0.95 cap in the same update that confirms recovery", async () => {
    const { executeTool } = await import("@/lib/tools");
    const state = newInvestigationState("x");
    const ctx = buildContext(state);
    for (const e of run.userEvidence) ctx.store.add(e);
    const out = executeTool(
      "update_investigation",
      { hypotheses: [{ ...run.hypotheses[0], confidence: 0.97, recoveryEvidence: undefined }, run.hypotheses[1]] },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(state.hypotheses[0].confidence).toBe(0.97);
    expect(state.incidentStatus).toBe("mitigated");
  });
});
