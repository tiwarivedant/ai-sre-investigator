import type { TraceStep } from "@/lib/types";
import type { RunProgress } from "./useInvestigation";

/**
 * Live readout for the trace header: which turn of this run's budget the agent
 * is on, and wall time so far. Follow-ups continue step numbering, so turns are
 * counted from the run's base step.
 */
export function runReadout(steps: TraceStep[], progress: RunProgress, running: boolean, now: number): { turn: number; maxTurns: number; elapsedS: number } {
  const lastStep = steps.reduce((m, t) => Math.max(m, t.step), progress.baseStep);
  // While running, the turn in flight is one past the last one that produced trace entries.
  const turn = Math.max(1, Math.min(progress.maxTurns, lastStep - progress.baseStep + (running ? 1 : 0)));
  return { turn, maxTurns: progress.maxTurns, elapsedS: Math.max(0, Math.round((now - progress.startedAt) / 1000)) };
}
