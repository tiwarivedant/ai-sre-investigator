import { NextResponse } from "next/server";
import { loadEvidenceStore, type EvidenceStore } from "@/lib/evidence/loader";
import { loadInvestigation } from "@/lib/store";

export const runtime = "nodejs";

const g = globalThis as { __evidence?: EvidenceStore };

/** Raw record for the evidence drawer. USER- evidence is per investigation (?investigation=<id>). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = (g.__evidence ??= loadEvidenceStore());
  let evidence = store.get(id);
  const invId = new URL(req.url).searchParams.get("investigation");
  if (!evidence && invId) evidence = loadInvestigation(invId)?.userEvidence.find((e) => e.id === id);
  if (!evidence) return NextResponse.json({ error: `No evidence ${id}` }, { status: 404 });
  return NextResponse.json(evidence);
}
