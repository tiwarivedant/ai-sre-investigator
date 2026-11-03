/**
 * Scenario eval: runs the checkout incident (no follow-ups) and checks the brief against
 * eval/expected.json. This script is the ONLY code that reads the answer key; nothing it
 * loads (app code, prompts, tools, retrieval) ever sees it.
 *
 *   npm run eval                 # one live run
 *   npm run eval -- --runs 3     # N runs, then a pass-rate summary
 *   REPLAY=1 npm run eval        # against the recorded fixture (no API key)
 *
 * Runs are saved under .investigations-eval/ (override with INVESTIGATIONS_DIR) so they
 * don't clutter the app's Recent list.
 */
import fs from "node:fs";
import path from "node:path";
import type { InvestigationState } from "@/lib/types";

for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f); // does not override variables already set
  } catch {
    // file absent: fine
  }
}
// Must be set before lib/store is imported (it reads the env at load time).
process.env.INVESTIGATIONS_DIR ??= ".investigations-eval";

const INCIDENT = "Customers are seeing errors at checkout and the site feels slow. Started maybe 15–20 min ago.";

interface Expected {
  root_cause: { summary: string; must_mention_any: string[]; service: string; key_evidence: string[] };
  red_herring: { id: string; why_rejected: string[] };
  noise_alerts: string[];
  similar_past_incident: string;
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const args = process.argv.slice(2);
const runsArg = args.indexOf("--runs");
const RUNS = runsArg >= 0 ? Math.max(1, Number(args[runsArg + 1]) || 1) : 1;

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// IDs written inline in the brief's text, e.g. "(LOG-076)" or "CFG-502:".
const INLINE_ID = /\b(?:ALR|LOG|DEP|CFG|MET|RB|INC|CHAT|CUST|USER)-[A-Za-z0-9_.-]*[A-Za-z0-9_]/g;

function citedIds(s: InvestigationState): Set<string> {
  const ids = new Set<string>();
  const add = (xs: (string | undefined)[] | undefined) => xs?.forEach((x) => x && ids.add(x));
  for (const h of s.hypotheses) {
    add(h.supporting);
    add(h.contradicting);
    add(h.recoveryEvidence);
  }
  add(s.timeline.map((t) => t.evidenceId));
  add(s.keySignals.map((k) => k.evidenceId));
  add(s.noise.map((n) => n.evidenceId));
  add(s.notNoise?.map((n) => n.evidenceId));
  for (const a of s.nextActions) add(a.evidence);
  add(s.similarIncidents?.map((x) => x.incidentId));
  for (const c of s.contributingFactors ?? []) add(c.evidence);
  for (const o of s.otherActiveIssues ?? []) add(o.evidence);
  const text = [s.summary, s.impact, s.stakeholderUpdate, ...s.openQuestions, ...s.hypotheses.flatMap((h) => [h.statement, h.reasoning])];
  for (const t of text) add(t.match(INLINE_ID) ?? undefined);
  return ids;
}

function evaluate(s: InvestigationState, exp: Expected, exists: (id: string) => boolean): Check[] {
  const checks: Check[] = [];
  const mentions = (h: { statement: string; reasoning: string }, terms: string[]) =>
    terms.some((t) => `${h.statement} ${h.reasoning}`.toLowerCase().includes(t.toLowerCase()));

  // (1) Top hypothesis: the highest-confidence one that isn't rejected.
  const ranked = s.hypotheses.filter((h) => h.status !== "rejected").sort((a, b) => b.confidence - a.confidence);
  const top = ranked[0];
  const topCites = top ? exp.root_cause.key_evidence.filter((id) => top.supporting.includes(id)) : [];
  const topMentions = top ? mentions(top, exp.root_cause.must_mention_any) : false;
  checks.push({
    name: "top hypothesis = root cause",
    pass: !!top && topCites.length > 0 && topMentions,
    detail: top
      ? `${top.id} (${top.confidence}) "${top.statement.slice(0, 90)}" · cites ${topCites.join(", ") || "no key evidence"} · ${topMentions ? "names the mechanism" : "does not name the mechanism"}`
      : "no non-rejected hypothesis",
  });

  // (2) Every hypothesis built on the red herring is rejected, and at least one exists.
  const rh = exp.red_herring.id;
  const about = s.hypotheses.filter((h) => h.supporting.includes(rh) || h.statement.includes(rh));
  const notRejected = about.filter((h) => h.status !== "rejected");
  checks.push({
    name: `${rh} hypothesis rejected`,
    pass: about.length > 0 && notRejected.length === 0,
    detail:
      about.length === 0
        ? `no hypothesis about ${rh}`
        : about.map((h) => `${h.id}: ${h.status} (${h.confidence})`).join(", "),
  });

  // (3) Every cited ID exists in the evidence store.
  const cited = [...citedIds(s)];
  const missing = cited.filter((id) => !exists(id));
  checks.push({
    name: "all citations valid",
    pass: missing.length === 0,
    detail: `${cited.length} cited IDs${missing.length ? `, unknown: ${missing.join(", ")}` : ""}${s.groundingIssues.length ? ` · guard stripped ${s.groundingIssues.length} during the run` : ""}`,
  });

  // (4) Noise alerts are classified as noise (and not overridden as signal).
  const noise = new Map(s.noise.map((n) => [n.evidenceId, n]));
  const notNoise = new Set((s.notNoise ?? []).map((n) => n.evidenceId));
  const wrong = exp.noise_alerts.filter((id) => !noise.has(id) || notNoise.has(id));
  checks.push({
    name: "noise alerts classified as noise",
    pass: wrong.length === 0,
    detail: exp.noise_alerts
      .map((id) => `${id}:${noise.has(id) && !notNoise.has(id) ? (noise.get(id)!.source ?? "agent") : "MISSING"}`)
      .join(" "),
  });

  // (5) The relevant past incident is surfaced.
  const sim = s.similarIncidents?.find((x) => x.incidentId === exp.similar_past_incident);
  checks.push({
    name: `${exp.similar_past_incident} in similar incidents`,
    pass: !!sim,
    detail: sim ? `source: ${sim.source}${sim.hypothesisId ? `, linked to ${sim.hypothesisId}` : ""}` : `found: ${(s.similarIncidents ?? []).map((x) => x.incidentId).join(", ") || "none"}`,
  });

  checks.push({ name: "run completed", pass: s.status === "complete", detail: s.status + (s.statusReason ? `: ${s.statusReason}` : "") });
  return checks;
}

async function main() {
  const expected = JSON.parse(fs.readFileSync(path.join(process.cwd(), "eval/expected.json"), "utf8")) as Expected;
  const { startInvestigation } = await import("@/lib/investigation");
  const { loadEvidenceStore } = await import("@/lib/evidence/loader");
  const { missingCredential, resolveProvider } = await import("@/lib/llm");
  const { loadFixture } = await import("@/lib/llm/replay");

  const provider = resolveProvider();
  const missing = missingCredential(provider);
  if (missing) {
    console.error(`LLM_PROVIDER=${provider} but ${missing} is not set.`);
    process.exit(1);
  }
  const incident = provider === "replay" ? loadFixture().incidentInput : INCIDENT;
  const store = loadEvidenceStore();
  const exists = (id: string) => store.has(id);

  console.log(bold(`Eval: ${RUNS} run${RUNS > 1 ? "s" : ""} · provider ${provider}`));
  console.log(dim(`incident: ${incident}\nsaving to ${process.env.INVESTIGATIONS_DIR}/\n`));

  const results: { id: string; checks: Check[]; seconds: number }[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const t0 = Date.now();
    let checks: Check[];
    let id = "-";
    try {
      const state = await startInvestigation(incident, { provider });
      id = state.id;
      checks = evaluate(state, expected, exists);
    } catch (err) {
      checks = [{ name: "run completed", pass: false, detail: `threw: ${(err as Error).message}` }];
    }
    const seconds = (Date.now() - t0) / 1000;
    results.push({ id, checks, seconds });
    const passed = checks.every((c) => c.pass);
    console.log(bold(`Run ${i}/${RUNS}`) + ` ${passed ? green("PASS") : red("FAIL")} ${dim(`${id} · ${seconds.toFixed(1)}s`)}`);
    for (const c of checks) console.log(`  ${c.pass ? green("✓") : red("✗")} ${c.name} ${dim(`— ${c.detail}`)}`);
    console.log();
  }

  // Pass-rate summary per check, then overall.
  const names = [...new Set(results.flatMap((r) => r.checks.map((c) => c.name)))];
  console.log(bold("Summary"));
  for (const n of names) {
    const ok = results.filter((r) => r.checks.find((c) => c.name === n)?.pass).length;
    const line = `  ${`${ok}/${RUNS}`.padStart(5)}  ${n}`;
    console.log(ok === RUNS ? line : red(line));
  }
  const allPass = results.filter((r) => r.checks.every((c) => c.pass)).length;
  const avg = results.reduce((a, r) => a + r.seconds, 0) / RUNS;
  console.log(bold(`\n  Pass rate: ${allPass}/${RUNS} runs (${Math.round((100 * allPass) / RUNS)}%) · avg ${avg.toFixed(1)}s per run`));
  if (allPass < RUNS) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
