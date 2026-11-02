import { NextResponse } from "next/server";
import { loadInvestigation } from "@/lib/store";
import { isRunning } from "@/lib/runs";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inv = loadInvestigation(id);
  if (!inv) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ state: inv.state, provider: inv.provider, model: inv.model, sample: !!inv.sample, running: isRunning(id) });
}
