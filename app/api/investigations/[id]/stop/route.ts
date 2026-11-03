import { NextResponse } from "next/server";
import { stopRun } from "@/lib/runs";

export const runtime = "nodejs";

/** Stop the run in progress; the agent ends at once and the brief so far is kept (status "partial"). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!stopRun(id)) return NextResponse.json({ error: "Nothing is running for this investigation." }, { status: 409 });
  return NextResponse.json({ id, stopping: true }, { status: 202 });
}
