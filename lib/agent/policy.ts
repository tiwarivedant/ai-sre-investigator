import type { ActionType, NextAction, Risk } from "@/lib/types";
import type { CorrelatedChange } from "@/lib/analysis/correlation";
import type { InvestigationUpdate } from "./schemas";

/**
 * Calibration policy, enforced in code on every update the agent writes.
 * The model proposes; these rules decide what is allowed to stand.
 *
 * 1. Only a human can confirm. A hypothesis may be "confirmed" only if it cites
 *    human-provided evidence (USER-xxx, pasted in a follow-up such as the change
 *    owner's statement), and only a confirmed one may exceed MAX_UNCONFIRMED_CONFIDENCE:
 *    citing a follow-up about something else (e.g. customer impact) does not lift the cap.
 *    Even a confirmed one stays at or below MAX_UNVERIFIED_CONFIDENCE until a human
 *    reports that the fix restored service (recoveryEvidence): an admitted
 *    change is strong evidence, a recovery after reverting it is proof.
 * 2. Action risk comes from a fixed rubric over the action type, escalated by
 *    keywords for operations the rubric must never under-rate.
 * 3. Undoing a mitigation (re-enabling a flag turned off during the incident,
 *    reverting a post-onset change) is only allowed after recovery is verified.
 */

export const MAX_UNCONFIRMED_CONFIDENCE = 0.85;
export const MAX_UNVERIFIED_CONFIDENCE = 0.95;
const HUMAN_EVIDENCE = /^USER-\d+$/;

export const RISK_RUBRIC: Record<ActionType, Risk> = {
  investigate: "low", // read-only checks
  communicate: "low",
  config_revert: "low", // hot-reloaded, reverts in seconds
  flag_change: "low",
  rollback: "medium", // code rollback: new pods, takes minutes
  pod_restart: "medium", // drops in-flight requests
  scale: "medium",
  other: "medium", // unknown is not low
  db_change: "high", // DB parameters, failover, killing sessions
  prevention: "low", // planned post-incident work; goes through normal change review, not done mid-incident
};

// Escalations: if the text describes one of these, the risk is at least this,
// whatever type the model chose.
const ESCALATIONS: { re: RegExp; risk: Risk; why: string }[] = [
  { re: /max_connections|pg_terminate|terminate (backend|session|connection)|kill (db |database )?(sessions|connections)|failover|vacuum|schema|migration|restart (the )?([\w-]*-)?(db|database|postgres)\b|database restart/i, risk: "high", why: "touches the database itself" },
  { re: /\b(restart|bounce|recycle|kill|roll)\b.*\b(pods?|replicas?|deployment|service)\b|\brolling restart\b|\brollout restart\b/i, risk: "medium", why: "restarts running workloads" },
  { re: /\broll ?back\b|\bredeploy\b/i, risk: "medium", why: "code rollback/redeploy" },
];

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

// Asking, confirming and communicating change nothing, whatever they mention ("Ask Dana ... the rollback").
const NON_CHANGING = /^\s*(ask|confirm|check|verify|validate|notify|tell|inform|communicate|page|post|update (the )?(ic|incident|stakeholders|status page|channel)|query|review|decide|monitor|watch|reconcile with|get|collect|find out|look up)\b/i;

export function assessRisk(type: ActionType, text: string): { risk: Risk; riskReason: string } {
  if (type !== "prevention" && NON_CHANGING.test(text)) {
    const verb = text.trim().split(/\s+/)[0].toLowerCase();
    return { risk: "low", riskReason: `rubric: "${verb}" changes nothing = low` };
  }
  let risk = RISK_RUBRIC[type];
  let riskReason = `rubric: ${type.replace("_", " ")} = ${risk}`;
  for (const e of ESCALATIONS) {
    if (e.re.test(text) && RANK[e.risk] > RANK[risk]) {
      risk = e.risk;
      riskReason = `escalated to ${risk}: ${e.why}`;
    }
  }
  return { risk, riskReason };
}

// Phrases that only make sense when undoing something switched off during the incident.
const UNDO_MITIGATION = /\bre-?enable|\bturn (it |this |the [\w-]+ )?back on\b|\bswitch (it |this )?back on\b/i;

/** Changes made after onset are mitigations (or incident-time actions); undoing them waits for recovery. */
export function mustWaitForRecovery(a: { action: string; evidence: string[] }, mitigationIds: Set<string>): boolean {
  if (UNDO_MITIGATION.test(a.action)) return true;
  return a.evidence.some((id) => mitigationIds.has(id)) && /\b(revert|undo|restore|roll ?back|back to|re-?apply)\b/i.test(a.action);
}

// Certainty language that is only true once a human has confirmed the cause.
const OVERCLAIMS: [RegExp, string][] = [
  [/\b(we have|we've)\s+(identified|found|determined|confirmed|pinpointed)\s+the\s+root\s+cause\b/gi, "we have identified the likely cause"],
  [/\b(identified|found|determined|confirmed|pinpointed)\s+the\s+root\s+cause\b/gi, "identified the likely cause"],
  [/\b(we have|we've)\s+confirmed\b/gi, "we believe"],
  [/\bthe\s+root\s+cause\b/gi, "the likely cause"],
  [/\broot\s+cause\b/gi, "likely cause"],
];

// Confirmed by a human, but the fix is not yet proven: a cause, not yet "the root cause".
const UNVERIFIED_OVERCLAIMS: [RegExp, string][] = [
  [/\b(confirmed|identified|found|determined|pinpointed)\s+the\s+root\s+cause\b/gi, "identified the cause"],
  [/\bthe\s+root\s+cause\b/gi, "the cause"],
  [/\broot\s+cause\b/gi, "cause"],
];

function rewrite(text: string, rules: [RegExp, string][]): string | null {
  let out = text;
  for (const [re, rep] of rules) {
    out = out.replace(re, (m) => (m[0] === m[0].toUpperCase() ? rep[0].toUpperCase() + rep.slice(1) : rep));
  }
  return out === text ? null : out;
}

/** Soften stakeholder wording to "likely" until a human confirms. Returns null if nothing changed. */
export function hedgeUnconfirmed(text: string): string | null {
  return rewrite(text, OVERCLAIMS);
}

/** Drop "root cause" certainty until recovery after the fix is verified. Returns null if nothing changed. */
export function hedgeUnverified(text: string): string | null {
  return rewrite(text, UNVERIFIED_OVERCLAIMS);
}

function recoveryVerified(h: { recoveryEvidence?: string[] }): boolean {
  return (h.recoveryEvidence ?? []).some((id) => HUMAN_EVIDENCE.test(id));
}

/** The highest confidence a hypothesis may hold, by how far a human has confirmed it (rule 1). */
export function confidenceCap(h: { status: string; recoveryEvidence?: string[] }): number {
  if (h.status !== "confirmed") return MAX_UNCONFIRMED_CONFIDENCE;
  return recoveryVerified(h) ? 1 : MAX_UNVERIFIED_CONFIDENCE;
}

type H = NonNullable<InvestigationUpdate["hypotheses"]>[number];

// --- Compound actions -------------------------------------------------------
// "Revert X and roll the pods, then watch Y" is three operations with different
// risks. Split on sequencing words when the next clause starts with an imperative.

const VERBS =
  "revert|restore|roll|restart|bounce|recycle|watch|monitor|check|verify|confirm|notify|page|tell|inform|update|post|scale|disable|enable|re-enable|turn|add|remove|increase|decrease|raise|lower|set|deploy|redeploy|rollback|kill|terminate|ask|decide|review|open|file|create|run|query|drain|pause|resume";
const SPLIT = new RegExp(`\\s*(?:;|,?\\s+then|,?\\s+and then|,?\\s+and(?=\\s+(?:${VERBS})\\b)|,(?=\\s+(?:${VERBS})\\b))\\s+`, "i");

/** Infer the operation type of a split-off clause; fall back to the agent's type for the action. */
export function inferType(text: string, fallback: ActionType): ActionType {
  const t = text.toLowerCase();
  // The clause's leading verb decides first: "decide whether to redeploy" is a decision, not a redeploy.
  if (/^(watch|monitor|check|verify|confirm|query|review|ask|decide)\b/.test(t)) return "investigate";
  if (/^(notify|page|tell|inform|post|update (the )?(ic|incident|stakeholders|status))/.test(t)) return "communicate";
  if (/max_connections|pg_terminate|failover|vacuum|\bmigration\b|restart (the )?([\w-]*-)?(db|database|postgres)\b/.test(t)) return "db_change";
  if (/\b(restart|bounce|recycle|roll(ing)?)\b.*\b(pods?|replicas?|deployment|service)\b|rollout restart/.test(t)) return "pod_restart";
  if (/\b(roll ?back|redeploy)\b/.test(t)) return "rollback";
  if (/^scale\b/.test(t)) return "scale";
  if (/\b(re-?enable|disable|turn (on|off)|flag)\b/.test(t)) return "flag_change";
  return fallback;
}

export function splitCompound(text: string): string[] {
  const parts = text
    .split(SPLIT)
    .map((p) => p.trim().replace(/[.,;]+$/, ""))
    .filter(Boolean);
  return parts.length > 1 ? parts.map((p) => p[0].toUpperCase() + p.slice(1)) : [text];
}

export interface PolicyResult {
  update: InvestigationUpdate;
  /** Human-readable adjustments, returned to the agent and shown in the trace. */
  adjustments: string[];
  /** Fully normalised actions (with risk and phase), when nextActions was sent. */
  nextActions?: NextAction[];
}

export function applyPolicy(
  update: InvestigationUpdate,
  changes: CorrelatedChange[],
  /** Hypotheses already in state, for updates that change the stakeholder text but not the hypotheses. */
  previousHypotheses: { status: string; recoveryEvidence?: string[] }[] = [],
): PolicyResult {
  const adjustments: string[] = [];
  const out: InvestigationUpdate = { ...update };

  if (out.hypotheses) {
    out.hypotheses = out.hypotheses.map((h) => {
      const humanBacked = h.supporting.some((id) => HUMAN_EVIDENCE.test(id));
      let next = h;
      if (h.status === "confirmed" && !humanBacked) {
        next = { ...next, status: "active" };
        adjustments.push(`${h.id}: "confirmed" requires human confirmation (cite USER- evidence); kept as active`);
      }
      const cap = confidenceCap(next);
      if (next.status !== "rejected" && next.confidence > cap) {
        adjustments.push(
          `${h.id}: confidence ${h.confidence} capped at ${cap} ${
            next.status === "confirmed" ? "until a human reports recovery after the fix (recoveryEvidence)" : "without human confirmation"
          }`,
        );
        next = { ...next, confidence: cap };
      }
      return next;
    });
  }

  const hyps = out.hypotheses ?? (previousHypotheses as H[]);
  const anyConfirmed = hyps.some((h) => h.status === "confirmed");
  const anyVerified = hyps.some((h) => h.status === "confirmed" && recoveryVerified(h));
  if (out.overallConfidence !== undefined) {
    const cap = anyVerified ? 1 : anyConfirmed ? MAX_UNVERIFIED_CONFIDENCE : MAX_UNCONFIRMED_CONFIDENCE;
    if (out.overallConfidence > cap) {
      adjustments.push(
        `overallConfidence ${out.overallConfidence} capped at ${cap} (${anyConfirmed ? "confirmed, but recovery not yet verified" : "nothing human-confirmed"})`,
      );
      out.overallConfidence = cap;
    }
  }

  // Stakeholder comms must not claim certainty the evidence doesn't have.
  if (out.stakeholderUpdate && !anyVerified) {
    const hedged = anyConfirmed ? hedgeUnverified(out.stakeholderUpdate) : hedgeUnconfirmed(out.stakeholderUpdate);
    if (hedged) {
      out.stakeholderUpdate = hedged;
      adjustments.push(
        anyConfirmed
          ? 'stakeholderUpdate: "root cause" wording softened to "cause" until recovery after the fix is verified'
          : 'stakeholderUpdate: certainty wording ("root cause", "confirmed") softened to "likely cause" until a human confirms',
      );
    }
  }

  let nextActions: NextAction[] | undefined;
  if (out.nextActions) {
    const mitigationIds = new Set(changes.filter((c) => c.relation === "after_onset").map((c) => c.id));
    nextActions = out.nextActions.flatMap((a, i) => {
      const parts = splitCompound(a.action);
      if (parts.length > 1) adjustments.push(`nextActions[${i}]: split into ${parts.length} actions so each gets its own risk`);
      return parts.map((text, j) => {
        const type = j === 0 ? a.type : inferType(text, a.type);
        let phase = a.phase ?? (type === "prevention" ? "prevention" : "now");
        if (phase === "now" && mustWaitForRecovery({ action: text, evidence: a.evidence }, mitigationIds)) {
          phase = "after_recovery";
          adjustments.push(`nextActions[${i}]: "${text}" undoes a mitigation; moved to after-recovery`);
        }
        if (phase === "prevention") {
          // Planned work: prioritised, not risk-rated.
          return {
            action: text,
            owner: a.owner,
            type,
            risk: "low" as const,
            riskReason: "not risk-rated: planned post-incident work",
            phase,
            priority: a.priority ?? "P2",
            evidence: a.evidence,
          };
        }
        const { risk, riskReason } = assessRisk(type, text);
        return { action: text, owner: a.owner, type, risk, riskReason, phase, evidence: a.evidence };
      });
    });
    // Do-now first, then after-recovery, then prevention; within a phase keep the agent's order.
    const order = { now: 0, after_recovery: 1, prevention: 2 } as const;
    nextActions.sort((x, y) => order[x.phase] - order[y.phase]);
  }

  return { update: out, adjustments, nextActions };
}

/** Finalize gate: an unconfirmed brief must say what is still unknown. */
export function missingOpenQuestions(state: { hypotheses: { status: string }[]; openQuestions: string[] }): boolean {
  return !state.hypotheses.some((h) => h.status === "confirmed") && state.openQuestions.length === 0;
}
