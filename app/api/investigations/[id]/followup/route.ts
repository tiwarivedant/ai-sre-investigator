import { NextResponse } from "next/server";
import { followUpInvestigation } from "@/lib/investigation";
import { isReplay, missingCredential } from "@/lib/llm";
import { loadInvestigation } from "@/lib/store";
import { isRunning, markRunning, publish } from "@/lib/runs";
import { cleanFollowUp } from "@/lib/text";
import { loadFixture, recordedFollowUps } from "@/lib/llm/replay";
import {
  expectedFollowUp,
  fixtureLabel,
  LIVE_IN_REPLAY,
  liveInReplayMessage,
  matchesRecordedIncident,
  READ_ONLY,
  readOnlyMessage,
  REPLAY_FOLLOWUP_MISMATCH,
  replayFollowUpMessage,
} from "@/lib/replayGuard";

export const runtime = "nodejs";

/** Add a responder's answer or new evidence; the agent resumes and the stream reopens. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { message?: string };
  const message = body.message ? cleanFollowUp(body.message) : "";
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });
  if (message.length > 8000) return NextResponse.json({ error: "message is too long (max 8000 chars)" }, { status: 400 });

  const inv = loadInvestigation(id);
  if (!inv) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (isRunning(id)) return NextResponse.json({ error: "investigation is still running" }, { status: 409 });
  if (inv.sample) return NextResponse.json({ error: readOnlyMessage(), code: READ_ONLY }, { status: 409 });
  // REPLAY=1 promises no real API calls; a live investigation would resume on its real provider.
  if (isReplay() && inv.provider !== "replay")
    return NextResponse.json({ error: liveInReplayMessage(inv.provider), code: LIVE_IN_REPLAY }, { status: 409 });
  if (inv.provider === "replay") {
    // Replay can only reproduce the follow-ups it recorded, in order.
    let fixture;
    try {
      fixture = loadFixture();
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
    const expected = expectedFollowUp(recordedFollowUps(fixture), inv.userEvidence.length);
    if (!expected || !matchesRecordedIncident(message, expected)) {
      const label = fixtureLabel(fixture.name);
      return NextResponse.json(
        { error: replayFollowUpMessage(label, expected), code: REPLAY_FOLLOWUP_MISMATCH, sample: { label, followUp: expected } },
        { status: 409 },
      );
    }
  }
  const missing = missingCredential(inv.provider);
  if (missing) return NextResponse.json({ error: `${missing} is not set (this investigation runs on ${inv.provider})` }, { status: 500 });

  const signal = markRunning(id);
  followUpInvestigation(id, message, { signal, onEvent: (e) => publish(id, e) }).catch((err) => {
    console.error(`follow-up on ${id} failed`, err);
    const state = loadInvestigation(id)?.state;
    if (state) {
      state.status = "error";
      state.statusReason = `Follow-up failed: ${(err as Error).message}`;
      publish(id, { type: "done", state });
    }
  });
  return NextResponse.json({ id }, { status: 202 });
}
