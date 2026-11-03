export type EvidenceKind =
  | "alert"
  | "log"
  | "deploy"
  | "config"
  | "metric"
  | "runbook"
  | "incident"
  | "chat"
  | "customer"
  | "user";

export interface Evidence {
  id: string; // "LOG-033", "CFG-502", "MET-orders_db.active_connections"
  kind: EvidenceKind;
  timestamp?: string; // ISO
  service?: string;
  title: string; // one-line human summary
  raw: unknown; // original record, shown in evidence drawer
}

export interface Hypothesis {
  id: string; // "H1"
  statement: string;
  confidence: number; // 0..1
  status: "active" | "rejected" | "confirmed";
  supporting: string[]; // evidence IDs
  contradicting: string[]; // evidence IDs
  reasoning: string;
  /** Human-reported evidence (USER-) that the fix restored service. Required for confidence above 0.95. */
  recoveryEvidence?: string[];
}

export interface TimelineEntry {
  /** Always derived by code from the evidence (or its change-point), never taken from the LLM. */
  ts: string;
  evidenceId: string;
  note: string;
  /** "ruled-out": evidence only a rejected hypothesis relies on (e.g. a red-herring deploy). */
  kind?: "event" | "follow-up" | "ruled-out";
  /** Who wrote the note: the agent, or code (from the evidence). Only agent notes carry over between refreshes. */
  source?: "agent" | "code";
}

export interface CitedNote {
  evidenceId: string;
  why: string;
  /** "code" = written by code (heuristic noise, derived key signals), not the agent. */
  source?: "agent" | "code";
  /** For noise: the heuristic flags that also mark it, alongside any agent reason. */
  flags?: string[];
}

export type Risk = "low" | "medium" | "high";

export type ActionType =
  | "investigate"
  | "communicate"
  | "config_revert"
  | "flag_change"
  | "rollback"
  | "pod_restart"
  | "scale"
  | "db_change"
  | "prevention" // post-incident engineering work to stop a recurrence
  | "other";

export interface NextAction {
  action: string;
  owner?: string;
  /** Chosen by the agent; risk is derived from it in code. */
  type: ActionType;
  /** Assigned deterministically (lib/agent/policy.ts), never by the LLM. */
  risk: Risk;
  riskReason: string;
  /** "after_recovery": only once recovery is verified (e.g. undoing a mitigation). "prevention": post-incident work. */
  phase: "now" | "after_recovery" | "prevention";
  /** Prevention items are prioritised, not risk-rated: they are planned work, not incident-time operations. */
  priority?: "P1" | "P2";
  evidence: string[];
  /** "code": derived deterministically (e.g. an open action item from a repeat incident). */
  source?: "agent" | "code";
}

export interface ContributingFactor {
  factor: string;
  evidence: string[];
  source: "agent" | "code";
}

export interface RepeatIncident {
  incidentId: string;
  hypothesisId: string;
  /** Action items from the earlier incident that are still unchecked. */
  openActionItems: string[];
}

export interface SimilarIncident {
  incidentId: string; // INC-xxxx
  hypothesisId?: string;
  similarity: string; // how this incident resembles the past one
  lesson: string; // what the past one teaches
  source: "agent" | "retrieval";
}

export interface TraceStep {
  step: number; // model turn; parallel tool calls in one turn share it
  /** Harness events that are not tool calls. */
  label?: "budget" | "retry" | "stopped";
  thought: string;
  tool?: string;
  args?: unknown;
  resultSummary?: string;
  ms: number;
}

export interface Revision {
  at: string;
  trigger: string;
  changes: string[]; // e.g. "H2 confidence 0.4 -> 0.8"
}

export type RunStatus = "running" | "complete" | "partial" | "error";

export interface InvestigationState {
  id: string;
  incidentInput: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  statusReason?: string; // why a run ended partial/error
  summary: string;
  impact: string;
  timeline: TimelineEntry[];
  keySignals: CitedNote[];
  noise: CitedNote[];
  hypotheses: Hypothesis[];
  openQuestions: string[];
  nextActions: NextAction[];
  stakeholderUpdate: string;
  overallConfidence: number;
  trace: TraceStep[];
  revisions: Revision[];
  groundingIssues: string[]; // citations the guard stripped, for transparency
  /** Past incidents resembling a hypothesis: from the agent, or matched by retrieval. */
  similarIncidents?: SimilarIncident[];
  /** Anomalies the brief does not account for anywhere, with evidence possibly related to each. Computed by code. */
  unexplained?: { evidenceId: string; what: string; related: { evidenceId: string; why: string }[] }[];
  /** Conditions that let the cause turn into an incident, or made it worse or slower to resolve. */
  contributingFactors?: ContributingFactor[];
  /** Set when a matched past incident had the same failure and left action items open. */
  repeatIncident?: RepeatIncident;
  /** Suspect changes (in the window before onset, or named by a responder) that no hypothesis tested. Computed by code. */
  untestedSuspects?: string[];
  /** Code-flagged noise the agent judged to be signal, with its reason. */
  notNoise?: CitedNote[];
  /** Brief text that contradicts the hypotheses' status (checked by code). */
  consistencyIssues?: string[];
  /** Actions a follow-up showed were already done, with the evidence that shows it. */
  doneActions?: { action: string; evidence: string[]; source: "agent" | "code" }[];
  /** Incident lifecycle, derived from human evidence: cause confirmed, recovery reported, resolution reported.
   * "insufficient-evidence": the available data says nothing about the reported symptom. */
  incidentStatus?: "insufficient-evidence" | "investigating" | "identified" | "mitigated" | "resolved";
  /** Does the data cover what was reported? Computed by code before the agent runs, refreshed with follow-ups. */
  coverage?: import("@/lib/analysis/coverage").Coverage;
  /** Set by the Resolve action (a human decision, no model involved). Cleared by Reopen. */
  resolution?: { evidenceId: string; at: string; recoveryVerified: boolean };
  /** When the incident was last reopened; resolution reports from before this no longer count. */
  reopenedAt?: string;
  /** Follow-ups classified as instructions (e.g. prompt injection): ignored, never evidence. */
  ignoredFollowUps?: { evidenceId: string; text: string; reason: string }[];
  /** Other incidents active in the data, shown separately from the answer (relationship to the report stated). */
  otherActiveIssues?: { title: string; evidence: string[]; relationship: string; source: "agent" | "code" }[];
  /** Who wrote the brief: the agent, or code (deterministic pre-analysis) because the agent never did. */
  briefSource?: "agent" | "pre-analysis";
}

/** The subset of InvestigationState the agent is allowed to write. */
export type AgentWritableField =
  | "summary"
  | "impact"
  | "timeline"
  | "keySignals"
  | "noise"
  | "hypotheses"
  | "openQuestions"
  | "nextActions"
  | "stakeholderUpdate"
  | "overallConfidence";
