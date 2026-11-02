import { NextResponse } from "next/server";
import { isReplay, resolveProvider } from "@/lib/llm";
import { DEFAULT_FIXTURE, loadFixture, recordedFollowUps } from "@/lib/llm/replay";
import { fixtureLabel } from "@/lib/replayGuard";
import { DEFAULT_GEMINI_MODEL } from "@/lib/llm/gemini";
import { DEFAULT_ANTHROPIC_MODEL } from "@/lib/llm/anthropic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const provider = resolveProvider();
    const model =
      provider === "replay"
        ? `fixture: ${process.env.REPLAY_FIXTURE ?? DEFAULT_FIXTURE}`
        : provider === "gemini"
          ? (process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL)
          : (process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL);
    let fixture: { label: string; incidentInput: string; followUps: string[] } | null = null;
    if (provider === "replay") {
      try {
        const f = loadFixture();
        fixture = { label: fixtureLabel(f.name), incidentInput: f.incidentInput, followUps: recordedFollowUps(f) };
      } catch {
        fixture = null; // missing fixture: starting a run reports the error
      }
    }
    return NextResponse.json({ provider, model, replay: isReplay(), fixture });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
