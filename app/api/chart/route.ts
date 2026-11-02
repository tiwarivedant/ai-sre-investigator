import { NextResponse } from "next/server";
import { loadEvidenceStore, type EvidenceStore } from "@/lib/evidence/loader";
import { runPreAnalysis, type PreAnalysis } from "@/lib/analysis/preAnalysis";
import { chartData } from "@/lib/analysis/chartData";

export const runtime = "nodejs";

const g = globalThis as { __chartInputs?: { store: EvidenceStore; pa: PreAnalysis } };

/** Series and event markers for the brief's "signals over time" chart (deterministic, from the pre-analysis). */
export async function GET() {
  if (!g.__chartInputs) {
    const store = loadEvidenceStore();
    g.__chartInputs = { store, pa: runPreAnalysis(store) };
  }
  return NextResponse.json(chartData(g.__chartInputs.pa, g.__chartInputs.store));
}
