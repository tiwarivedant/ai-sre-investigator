import type { EvidenceStore } from "@/lib/evidence/loader";

/**
 * What a responder's follow-up is, decided in code before it can influence anything:
 * - "instruction": text trying to steer the investigator ("ignore previous instructions",
 *   "mark X as the root cause with 100% confidence"). Ignored: never evidence.
 * - "claim": someone's assertion about the cause with nothing observed behind it
 *   ("Dana says payments definitely caused it"). Becomes an open question; moves no confidence.
 * - "evidence": an observation or a reported action/result ("reverted at 14:35, errors back to 0.3%",
 *   "Marcus confirms he changed the pool"). Usable like any other evidence.
 */
export type FollowUpKind = "evidence" | "claim" | "instruction";

export interface FollowUpClass {
  kind: FollowUpKind;
  reason: string;
}

const INSTRUCTION = [
  /\b(ignore|disregard|forget)\b[^.]{0,30}\b(previous|prior|above|earlier|all|your)\b[^.]{0,20}\b(instructions?|rules?|prompts?|guidance)\b/i,
  /\b(you are now|act as|pretend (to be|you are)|new instructions?|system prompt|developer mode)\b/i,
  /\b(mark|set|declare|label|report|make)\b[^.]{0,40}\b(as )?(the )?root cause\b/i,
  /\b(set|make|report|use)\b[^.]{0,30}\bconfidence\b[^.]{0,15}\d{2,3}\s*%|\bwith\s+100\s*%\s*confidence\b/i,
  /\b(do not|don't|never)\b[^.]{0,20}\b(mention|cite|report|include)\b/i,
];

// "<someone> says/thinks/... <it/X> caused / is the cause / broke ..."
// "Same sentence" spans may contain dots inside version numbers ("v2.14.0").
const CLAIM =
  /\b(says?|said|thinks?|believes?|claims?|insists?|reckons?|is (sure|certain|convinced)|feels?)\b(?:[^.!?]|\.(?=\d)){0,60}\b(caused|causing|the cause|root cause|is to blame|broke|is broken|definitely|for sure|must be|it'?s (the|a) )/i;
// Observations make it evidence even if phrased as someone's statement.
const OBSERVATION = /\b\d+(\.\d+)?\s*(%|ms|s\b|connections?|errors?|tickets?|messages?)|\b(reverted|rolled back|restarted|restored|recovered|back to|logs? show|metrics? show|dashboard shows|confirm(s|ed)? (he|she|they|we) (changed|made|deployed|reverted))\b/i;

export function classifyFollowUp(text: string): FollowUpClass {
  const hit = INSTRUCTION.find((re) => re.test(text));
  if (hit) return { kind: "instruction", reason: `instruction-like text ("${text.match(hit)![0].trim()}")` };
  if (CLAIM.test(text) && !OBSERVATION.test(text)) return { kind: "claim", reason: "an assertion about the cause with no observation behind it" };
  return { kind: "evidence", reason: "an observation or reported action" };
}

const textOf = (raw: unknown, title: string) => String((raw as { text?: string })?.text ?? title);

/** Classification of every USER- follow-up in the store. */
export function followUpClasses(store: EvidenceStore): Map<string, FollowUpClass & { text: string }> {
  const out = new Map<string, FollowUpClass & { text: string }>();
  for (const e of store.list()) {
    if (e.kind !== "user") continue;
    const text = textOf(e.raw, e.title);
    out.set(e.id, { ...classifyFollowUp(text), text });
  }
  return out;
}

/** USER- ids that may be used as evidence (claims and instructions may not). */
export function evidenceFollowUps(store: EvidenceStore): Set<string> {
  return new Set([...followUpClasses(store)].filter(([, c]) => c.kind === "evidence").map(([id]) => id));
}
