import { NextResponse } from "next/server";
import { startInvestigation } from "@/lib/investigation";
import { missingCredential, resolveProvider } from "@/lib/llm";
import { markRunning, publish } from "@/lib/runs";
import { listInvestigations } from "@/lib/store";
import { loadFixture } from "@/lib/llm/replay";
import { fixtureLabel, matchesRecordedIncident, REPLAY_MISMATCH, replayMismatchMessage } from "@/lib/replayGuard";

export const runtime = "nodejs";

/** Recent saved investigations and the read-only samples, as summaries for the history list. */
export async function GET() {
  return NextResponse.json(listInvestigations(), { headers: { "Cache-Control": "no-store" } });
}

/** Start an investigation. Returns its id as soon as it exists; progress streams over SSE. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { incident?: string };
  const incident = body.incident?.trim();
  if (!incident) return NextResponse.json({ error: "incident is required" }, { status: 400 });
  if (incident.length > 4000) return NextResponse.json({ error: "incident text is too long (max 4000 chars)" }, { status: 400 });

  let provider;
  try {
    provider = resolveProvider();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
  if (provider === "replay") {
    // A replay can only reproduce the incident it recorded; anything else would show a made-up investigation.
    let fixture;
    try {
      fixture = loadFixture();
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
    if (!matchesRecordedIncident(incident, fixture.incidentInput)) {
      const label = fixtureLabel(fixture.name);
      return NextResponse.json(
        { error: replayMismatchMessage(label), code: REPLAY_MISMATCH, sample: { label, incidentInput: fixture.incidentInput } },
        { status: 409 },
      );
    }
  }
  const missing = missingCredential(provider);
  if (missing) return NextResponse.json({ error: `${missing} is not set for LLM_PROVIDER=${provider}` }, { status: 500 });

  try {
    const controller = new AbortController(); // Stop aborts this run
    const id = await new Promise<string>((resolve, reject) => {
      let runId: string | undefined;
      startInvestigation(incident, {
        provider,
        signal: controller.signal,
        onStart: (s) => {
          runId = s.id;
          markRunning(s.id, controller);
          resolve(s.id);
        },
        onEvent: (e) => runId && publish(runId, e),
      }).catch((err) => {
        if (!runId) return reject(err);
        console.error(`investigation ${runId} crashed`, err);
      });
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
