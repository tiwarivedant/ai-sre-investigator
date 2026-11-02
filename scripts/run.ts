/**
 * Run an investigation end to end from the terminal.
 *
 *   npm run investigate                       # uses the example incident text
 *   npm run investigate -- "checkout is down"  # custom incident text
 *   npm run investigate -- --pre-analysis      # print deterministic pre-analysis only (no API key needed)
 *   npm run investigate -- --out brief.md      # also write the brief to a file
 *   npm run investigate -- --followup latest "Marcus confirms he changed the pool"
 *                                             # resume an investigation (id or "latest") with new info
 */
import fs from "node:fs";
import { followUpInvestigation, startInvestigation } from "@/lib/investigation";
import { cleanFollowUp, revisionLabel } from "@/lib/text";
import { latestInvestigationId, loadInvestigation } from "@/lib/store";
import type { AgentEvent } from "@/lib/agent/loop";
import { briefToMarkdown } from "@/lib/brief/markdown";
import { loadEvidenceStore } from "@/lib/evidence/loader";
import { formatPreAnalysis, runPreAnalysis } from "@/lib/analysis/preAnalysis";
import { missingCredential, resolveProvider } from "@/lib/llm";
import { loadFixture, recordedFollowUps } from "@/lib/llm/replay";
import { expectedFollowUp, fixtureLabel, matchesRecordedIncident, replayFollowUpMessage, replayMismatchMessage } from "@/lib/replayGuard";

for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f); // Node 22+; does not override variables already set
  } catch {
    // file absent: fine
  }
}

const EXAMPLE ="Customers are seeing errors at checkout and the site feels slow. Started maybe 15–20 min ago.";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const optionValues = new Set([option("--out"), option("--followup")]);
const freeText = cleanFollowUp(args.filter((a) => !a.startsWith("--") && !optionValues.has(a)).join(" "));
let incidentOverride: string | undefined;
const incidentText = () => incidentOverride ?? (freeText || EXAMPLE);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

async function main() {
  if (flag("--pre-analysis")) {
    console.log(formatPreAnalysis(runPreAnalysis(loadEvidenceStore())));
    return;
  }
  const followupArg = option("--followup");
  const followupId = followupArg === "latest" ? latestInvestigationId() : followupArg;
  if (followupArg && !freeText) {
    console.error('A follow-up needs a message, e.g. --followup latest "Marcus confirms he changed the pool"');
    process.exit(1);
  }
  if (followupArg && !followupId) {
    console.error("No saved investigation to follow up on. Run one first.");
    process.exit(1);
  }
  // A follow-up resumes on the provider that started the investigation.
  const provider = followupId ? (loadInvestigation(followupId)?.provider ?? resolveProvider()) : resolveProvider();
  const missing = missingCredential(provider);
  if (missing) {
    console.error(`LLM_PROVIDER=${provider} but ${missing} is not set. Export it or put it in .env.local (see .env.example).`);
    process.exit(1);
  }

  if (provider === "replay" && !followupId) {
    const fixture = loadFixture();
    // No custom text given: use the recorded incident. Different text: refuse rather than replay a mismatched run.
    if (!freeText) incidentOverride = fixture.incidentInput;
    else if (!matchesRecordedIncident(freeText, fixture.incidentInput)) {
      console.error(replayMismatchMessage(fixtureLabel(fixture.name)));
      console.error(`Recorded incident: "${fixture.incidentInput}"`);
      process.exit(1);
    }
  }

  if (provider === "replay" && followupId) {
    const fixture = loadFixture();
    const expected = expectedFollowUp(recordedFollowUps(fixture), loadInvestigation(followupId)?.userEvidence.length ?? 0);
    if (!expected || !matchesRecordedIncident(freeText, expected)) {
      console.error(replayFollowUpMessage(fixtureLabel(fixture.name), expected));
      process.exit(1);
    }
  }

  const onEvent = (e: AgentEvent) => {
    if (e.type === "trace") {
      const t = e.step;
      if (t.thought) console.log(dim(`  … ${t.thought.replace(/\s+/g, " ").slice(0, 300)}`));
      const args = t.args ? JSON.stringify(t.args) : "";
      console.log(
        `[turn ${t.step}] ${t.tool ? bold(t.tool) : t.label ? `(${t.label})` : "(thinking)"} ${dim(args.length > 160 ? `${args.slice(0, 159)}…` : args)}` +
          `${t.resultSummary ? `\n     → ${t.resultSummary}` : ""} ${dim(`${t.ms}ms`)}`,
      );
    } else if (e.type === "state") {
      const hs = e.state.hypotheses.map((h) => `${h.id}:${h.status}:${h.confidence}`).join("  ");
      console.log(dim(`     state: ${hs}`));
    }
  };

  const started = Date.now();
  let state;
  if (followupId) {
    console.log(bold(`Follow-up on ${followupId}: ${incidentText()}`));
    console.log(dim(`provider: ${provider}\n`));
    state = await followUpInvestigation(followupId, incidentText(), { onEvent });
  } else {
    console.log(bold(`Investigating: ${incidentText()}`));
    console.log(dim(`provider: ${provider}\n`));
    state = await startInvestigation(incidentText(), { provider, onEvent });
  }

  const md = briefToMarkdown(state);
  console.log(`\n${"─".repeat(72)}\n`);
  console.log(md);
  const rev = followupId ? state.revisions.at(-1) : undefined;
  if (rev) console.log(bold(`What changed (${revisionLabel(rev.trigger)}):\n`) + rev.changes.map((c) => `  • ${c}`).join("\n") + "\n");
  console.log(dim(`${state.status} in ${((Date.now() - started) / 1000).toFixed(1)}s · ${state.trace.length} trace steps · saved .investigations/${state.id}.json`));
  const out = option("--out");
  if (out) {
    fs.writeFileSync(out, md);
    console.log(dim(`brief written to ${out}`));
  }
  if (state.status === "error") process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
