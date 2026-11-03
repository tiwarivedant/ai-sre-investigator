/**
 * Publish a saved investigation as a read-only sample (browsable without an API key).
 *
 *   npm run save-sample -- latest --name inc-2213-confirmed
 *   npm run save-sample -- <id> --name inc-2213-rate-limited --label "Rate limited"
 *
 * Writes samples/investigations/<name>.json with id "sample-<name>". The model
 * conversation is dropped: samples are never resumed.
 */
import fs from "node:fs";
import path from "node:path";
import { latestInvestigationId, loadInvestigation, SAMPLES_DIR, type StoredInvestigation } from "@/lib/store";
import { loadFixture } from "@/lib/llm/replay";

const args = process.argv.slice(2);
const nameIdx = args.indexOf("--name");
const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
const labelIdx = args.indexOf("--label");
const label = labelIdx >= 0 ? args[labelIdx + 1]?.trim() || undefined : undefined;
const target = args.find((a, i) => !a.startsWith("--") && i !== nameIdx + 1 && i !== labelIdx + 1) ?? "latest";
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error("Usage: npm run save-sample -- <id|latest> --name <kebab-case-name>");
  process.exit(1);
}
const id = target === "latest" ? latestInvestigationId() : target;
const stored = id ? loadInvestigation(id) : undefined;
if (!stored) {
  console.error(`No saved investigation ${id ?? "(none found)"}`);
  process.exit(1);
}
if (stored.state.status === "running") {
  console.error("That investigation is still running.");
  process.exit(1);
}

// Replayed runs: credit the live run the model turns were recorded from.
let recordedFrom = `${stored.provider}/${stored.model}`;
if (stored.provider === "replay") {
  const f = loadFixture(stored.model.replace(/^replay:/, ""));
  recordedFrom = `${f.source.provider}/${f.source.model}, replayed from fixture "${f.name}"`;
}

const sampleId = `sample-${name}`;
const sample: StoredInvestigation = {
  ...stored,
  state: { ...stored.state, id: sampleId },
  history: [],
  sample: true,
  recordedFrom,
  label,
};
fs.mkdirSync(SAMPLES_DIR, { recursive: true });
const file = path.join(SAMPLES_DIR, `${name}.json`);
fs.writeFileSync(file, JSON.stringify(sample, null, 2) + "\n");
console.log(`Saved ${path.relative(process.cwd(), file)} (${sampleId}) from ${id}: ${stored.state.status}, ${stored.state.revisions.length} follow-up(s), recorded from ${recordedFrom}`);
