import { buildContext } from "@/lib/investigation";
import { refreshDerived } from "@/lib/agent/derived";
import { makeRevision, snapshot } from "@/lib/agent/revisions";
import { loadInvestigation, saveInvestigation } from "@/lib/store";
import { isRunning } from "@/lib/runs";
import { cleanFollowUp } from "@/lib/text";
import type { InvestigationState } from "@/lib/types";

/**
 * Responder actions: deterministic, no model call. Each records the responder's
 * words as USER evidence, re-derives the brief, and adds a revision. The agent
 * is shown these notes at its next follow-up.
 */
export type ActionKind = "note" | "resolve" | "reopen";

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "read_only" | "running" | "invalid" | "needs_confirmation" | "conflict",
    readonly status: number,
  ) {
    super(message);
  }
}

const MAX_COMMENT = 2000;

export function applyAction(id: string, kind: ActionKind, rawComment: string | undefined, opts: { confirm?: boolean } = {}): InvestigationState {
  const stored = loadInvestigation(id);
  if (!stored) throw new ActionError(`No investigation ${id}`, "not_found", 404);
  if (stored.sample) throw new ActionError("Samples are read-only.", "read_only", 409);
  if (isRunning(id) || stored.state.status === "running") throw new ActionError("The agent is still working on this investigation.", "running", 409);

  const comment = cleanFollowUp(rawComment ?? "");
  if (comment.length > MAX_COMMENT) throw new ActionError(`Comment is too long (max ${MAX_COMMENT} characters).`, "invalid", 400);
  if ((kind === "note" || kind === "resolve") && !comment) throw new ActionError(kind === "resolve" ? "A resolution comment is required." : "The note is empty.", "invalid", 400);

  const { state } = stored;
  const ctx = buildContext(state);
  for (const e of stored.userEvidence) ctx.store.add(e);
  refreshDerived(state, ctx.pa, ctx.store); // current status, from the same rules as everywhere else
  const before = snapshot(state);
  const now = new Date().toISOString();

  if (kind === "resolve") {
    if (state.incidentStatus === "resolved") throw new ActionError("The incident is already resolved.", "conflict", 409);
    const recoveryVerified = state.incidentStatus === "mitigated";
    if (!recoveryVerified && !opts.confirm)
      throw new ActionError(
        `Recovery hasn't been verified (status: ${state.incidentStatus ?? "investigating"}). Resolve anyway?`,
        "needs_confirmation",
        409,
      );
  }
  if (kind === "reopen" && state.incidentStatus !== "resolved") throw new ActionError("Only a resolved incident can be reopened.", "conflict", 409);

  const evidence = comment || kind === "reopen" ? ctx.store.addUserEvidence(comment || "Reopened by responder.", now, kind) : undefined;
  if (kind === "resolve") state.resolution = { evidenceId: evidence!.id, at: now, recoveryVerified: before.incidentStatus === "mitigated" };
  if (kind === "reopen") {
    state.resolution = undefined;
    state.reopenedAt = now;
  }

  refreshDerived(state, ctx.pa, ctx.store);
  state.updatedAt = now;
  const label = { note: "note", resolve: "resolved", reopen: "reopened" }[kind];
  state.revisions.push(makeRevision(`${label}${evidence ? ` ${evidence.id}` : ""}${comment ? `: ${comment.length > 90 ? `${comment.slice(0, 89)}…` : comment}` : ""}`, before, snapshot(state)));

  saveInvestigation({
    ...stored,
    state,
    userEvidence: evidence ? [...stored.userEvidence, evidence] : stored.userEvidence,
    undeliveredNotes: evidence ? [...(stored.undeliveredNotes ?? []), evidence.id] : stored.undeliveredNotes,
  });
  return state;
}
