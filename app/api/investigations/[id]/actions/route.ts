import { NextResponse } from "next/server";
import { ActionError, applyAction, type ActionKind } from "@/lib/actions";

export const runtime = "nodejs";

const KINDS: ActionKind[] = ["note", "resolve", "reopen"];

/** Responder actions (no model call): add a note, resolve (comment required), reopen. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string; comment?: string; confirm?: boolean };
  if (!KINDS.includes(body.action as ActionKind)) return NextResponse.json({ error: `action must be one of ${KINDS.join(", ")}` }, { status: 400 });
  try {
    const state = applyAction(id, body.action as ActionKind, body.comment, { confirm: body.confirm === true });
    return NextResponse.json({ state });
  } catch (err) {
    if (err instanceof ActionError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }
}
