// Shared by server and client: replay mode can only reproduce the incident it recorded.

export const REPLAY_MISMATCH = "replay_mismatch";

/** Same incident text, ignoring case and whitespace differences. */
export function matchesRecordedIncident(input: string, recorded: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(input) === norm(recorded);
}

export function replayMismatchMessage(sampleLabel: string): string {
  return `Replay mode only includes the recorded sample incident (${sampleLabel}). Set an API key and turn off REPLAY to investigate other prompts.`;
}

/** "inc-2213" -> "INC-2213" */
export const fixtureLabel = (fixtureName: string) => fixtureName.toUpperCase();

export const REPLAY_FOLLOWUP_MISMATCH = "replay_followup_mismatch";

/** The recorded follow-up a replayed investigation can accept next, or null when all have been used. */
export function expectedFollowUp(recordedFollowUps: string[], alreadySent: number): string | null {
  return recordedFollowUps[alreadySent] ?? null;
}

export function replayFollowUpMessage(sampleLabel: string, expected: string | null): string {
  return expected
    ? `Replay mode only includes the recorded follow-up for the sample incident (${sampleLabel}): "${expected}". Set an API key and turn off REPLAY to send other follow-ups.`
    : `Replay mode has no more recorded follow-ups for the sample incident (${sampleLabel}). Set an API key and turn off REPLAY to continue this investigation.`;
}

export const READ_ONLY = "read_only";
export const LIVE_IN_REPLAY = "live_in_replay";

export const readOnlyMessage = () => "Samples are read-only. Run your own investigation to send follow-ups.";

export const liveInReplayMessage = (provider: string) =>
  `This investigation ran live on ${provider}. Turn off REPLAY (and set its API key) to send follow-ups.`;
