import type { AgentEvent } from "@/lib/agent/loop";

/**
 * In-process pub/sub for live runs: the route that starts a run publishes agent
 * events; SSE routes subscribe. On globalThis for the same reason as the store.
 */
type Listener = (e: AgentEvent) => void;
interface Channel {
  listeners: Set<Listener>;
  running: boolean;
  /** Aborts the run in progress (Stop). */
  controller?: AbortController;
}

const g = globalThis as { __runs?: Map<string, Channel> };
const channels = (g.__runs ??= new Map<string, Channel>());

function channel(id: string): Channel {
  let c = channels.get(id);
  if (!c) channels.set(id, (c = { listeners: new Set(), running: false }));
  return c;
}

/** Mark a run as started; returns the signal that Stop will abort. */
export function markRunning(id: string, controller = new AbortController()): AbortSignal {
  const c = channel(id);
  c.running = true;
  c.controller = controller;
  return controller.signal;
}

/** Stop a run in progress. Returns false if nothing is running. */
export function stopRun(id: string): boolean {
  const c = channels.get(id);
  if (!c?.running || !c.controller) return false;
  c.controller.abort();
  return true;
}

export function publish(id: string, e: AgentEvent) {
  const c = channel(id);
  if (e.type === "done") c.running = false;
  for (const l of c.listeners) l(e);
}

export function subscribe(id: string, l: Listener): () => void {
  const c = channel(id);
  c.listeners.add(l);
  return () => c.listeners.delete(l);
}

export function isRunning(id: string): boolean {
  return channels.get(id)?.running ?? false;
}
