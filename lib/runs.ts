import type { AgentEvent } from "@/lib/agent/loop";

/**
 * In-process pub/sub for live runs: the route that starts a run publishes agent
 * events; SSE routes subscribe. On globalThis for the same reason as the store.
 */
type Listener = (e: AgentEvent) => void;
interface Channel {
  listeners: Set<Listener>;
  running: boolean;
}

const g = globalThis as { __runs?: Map<string, Channel> };
const channels = (g.__runs ??= new Map<string, Channel>());

function channel(id: string): Channel {
  let c = channels.get(id);
  if (!c) channels.set(id, (c = { listeners: new Set(), running: false }));
  return c;
}

export function markRunning(id: string) {
  channel(id).running = true;
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
