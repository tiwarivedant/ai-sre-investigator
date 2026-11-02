/**
 * Save a recorded investigation as a replay fixture (no API calls).
 *
 *   npm run save-fixture -- latest              # -> fixtures/inc-2213.json
 *   npm run save-fixture -- <id> --name my-run  # -> fixtures/my-run.json
 *
 * Then run anything with REPLAY=1 (optionally REPLAY_FIXTURE=my-run).
 */
import fs from "node:fs";
import path from "node:path";
import { latestInvestigationId, loadInvestigation } from "@/lib/store";
import { DEFAULT_FIXTURE, extractRuns, FIXTURE_DIR, type Fixture } from "@/lib/llm/replay";

const args = process.argv.slice(2);
const nameIdx = args.indexOf("--name");
const name = nameIdx >= 0 ? args[nameIdx + 1] : DEFAULT_FIXTURE;
const target = args.find((a, i) => !a.startsWith("--") && i !== nameIdx + 1) ?? "latest";
const id = target === "latest" ? latestInvestigationId() : target;

const stored = id ? loadInvestigation(id) : undefined;
if (!stored) {
  console.error(`No saved investigation ${id ?? "(none found)"} in .investigations/`);
  process.exit(1);
}
if (stored.provider === "replay") {
  console.error("That investigation was itself a replay; save a live run instead.");
  process.exit(1);
}
if (stored.state.status !== "complete") {
  console.error(`Investigation ${id} ended "${stored.state.status}" (${stored.state.statusReason ?? ""}). Save a run that looks right.`);
  process.exit(1);
}

const fixture: Fixture = {
  name,
  recordedAt: stored.state.updatedAt,
  source: { provider: stored.provider, model: stored.model, investigationId: stored.state.id },
  incidentInput: stored.state.incidentInput,
  runs: extractRuns(stored.provider, stored.history),
};
fs.mkdirSync(FIXTURE_DIR, { recursive: true });
const file = path.join(FIXTURE_DIR, `${name}.json`);
fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Saved ${path.relative(process.cwd(), file)} from ${id} (${stored.provider}/${stored.model})`);
for (const r of fixture.runs) {
  console.log(`  ${r.kind}${r.message ? ` "${r.message}"` : ""}: ${r.turns.length} turns · ${r.turns.flatMap((t) => t.toolCalls.map((c) => c.name)).join(", ")}`);
}
