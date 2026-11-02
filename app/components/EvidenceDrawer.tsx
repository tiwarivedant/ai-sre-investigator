"use client";

import { useEffect, useState } from "react";
import type { Evidence } from "@/lib/types";

export function EvidenceDrawer({ id, investigationId, onClose }: { id: string | null; investigationId?: string; onClose: () => void }) {
  const [data, setData] = useState<{ id: string; evidence?: Evidence; error?: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const q = investigationId ? `?investigation=${encodeURIComponent(investigationId)}` : "";
    fetch(`/api/evidence/${encodeURIComponent(id)}${q}`)
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => !cancelled && setData(ok ? { id, evidence: body } : { id, error: body.error ?? "Not found" }))
      .catch((e) => !cancelled && setData({ id, error: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [id, investigationId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!id) return null;
  const loading = !data || data.id !== id;
  const ev = loading ? undefined : data.evidence;
  const raw = ev?.raw as { text?: string } | undefined;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Evidence ${id}`}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <div className="font-mono text-sm font-semibold text-zinc-100">{id}</div>
            {ev && <div className="mt-0.5 text-sm text-zinc-400">{ev.title}</div>}
          </div>
          <button type="button" onClick={onClose} className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800">
            Esc
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading && <p className="text-sm text-zinc-500">Loading…</p>}
          {!loading && data.error && <p className="text-sm text-red-300">{data.error}</p>}
          {ev && (
            <>
              <dl className="mb-4 grid grid-cols-[6rem_1fr] gap-y-1 text-xs">
                <dt className="text-zinc-500">Kind</dt>
                <dd className="text-zinc-300">{ev.kind}</dd>
                {ev.service && (
                  <>
                    <dt className="text-zinc-500">Service</dt>
                    <dd className="text-zinc-300">{ev.service}</dd>
                  </>
                )}
                {ev.timestamp && (
                  <>
                    <dt className="text-zinc-500">Time</dt>
                    <dd className="font-mono text-zinc-300">{ev.timestamp.replace("T", " ").replace("Z", " UTC")}</dd>
                  </>
                )}
              </dl>
              {typeof raw?.text === "string" ? (
                <pre className="rounded-md border border-zinc-800 bg-zinc-900 p-3 text-xs leading-relaxed whitespace-pre-wrap text-zinc-300">{raw.text}</pre>
              ) : (
                <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs text-zinc-300">{JSON.stringify(ev.raw, null, 2)}</pre>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
