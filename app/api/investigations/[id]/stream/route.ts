import { loadInvestigation } from "@/lib/store";
import { isRunning, subscribe } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE: first a snapshot of the current state (so late or reconnecting clients
 * catch up), then live trace/state events until the run is done.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inv = loadInvestigation(id);
  if (!inv) return new Response("not found", { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };

      send("snapshot", { state: inv.state, provider: inv.provider, model: inv.model, sample: !!inv.sample, recordedFrom: inv.recordedFrom, label: inv.label });
      if (!isRunning(id)) {
        send("done", { state: inv.state });
        return close();
      }
      const unsubscribe = subscribe(id, (e) => {
        if (e.type === "trace") send("trace", e.step);
        else send(e.type, { state: e.state });
        if (e.type === "done") close();
      });
      const ping = setInterval(() => !closed && controller.enqueue(encoder.encode(": ping\n\n")), 15_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
      };
      req.signal.addEventListener("abort", close);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
