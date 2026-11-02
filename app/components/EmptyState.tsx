"use client";

import { useEffect, useRef } from "react";
import { InvestigationRow, useInvestigationList } from "./History";

// Different ways a responder might first describe the same incident: vague, symptom-led, and
// anchored on the obvious suspect (the agent has to test that suspicion, not accept it).
export const EXAMPLE_PROMPTS = [
  "Customers are seeing errors at checkout and the site feels slow. Started maybe 15–20 min ago.",
  "orders-service is throwing 503s and the orders-db connection alert just went critical.",
  "Payments shipped v2.14.0 right before checkout started failing. Is it the deploy?",
];

export function EmptyState({
  incident,
  setIncident,
  onRun,
  running,
  replaySample,
  onOpen,
}: {
  incident: string;
  setIncident: (v: string) => void;
  onRun: () => void;
  running: boolean;
  /** In replay mode only the recorded incident can run. */
  replaySample?: string | null;
  onOpen: (id: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const { lists, failed, refresh } = useInvestigationList();
  useEffect(refresh, [refresh]);
  useEffect(() => input.current?.focus(), []);
  const examples = replaySample ? [replaySample] : EXAMPLE_PROMPTS;
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

  return (
    <div className="mx-auto max-w-3xl py-6 sm:py-10">
      <h2 className="text-lg font-semibold tracking-tight text-zinc-100">What are responders seeing?</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Describe the incident in a sentence or two. The agent reads alerts, logs, deploys, config changes, metrics, runbooks and past incidents, and cites
        the evidence for every claim.
      </p>

      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          onRun();
        }}
      >
        <label htmlFor="incident" className="sr-only">
          Describe the incident
        </label>
        <textarea
          ref={input}
          id="incident"
          rows={3}
          value={incident}
          onChange={(e) => setIncident(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Symptoms, who is affected, roughly when it started…"
          className="block w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-xs text-zinc-600">
            <kbd className="rounded border border-zinc-700 px-1 font-sans text-[11px] text-zinc-400">{isMac ? "⌘" : "Ctrl"}</kbd> +{" "}
            <kbd className="rounded border border-zinc-700 px-1 font-sans text-[11px] text-zinc-400">Enter</kbd> to run
          </span>
          <button
            type="submit"
            disabled={running || !incident.trim()}
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "Investigating…" : "Run investigation"}
          </button>
        </div>
      </form>

      <div className="mt-5">
        <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{replaySample ? "Recorded sample (replay mode)" : "Try an example"}</h3>
        <div className="flex flex-col gap-1.5">
          {examples.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                setIncident(ex);
                input.current?.focus();
              }}
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                incident === ex ? "border-zinc-500 bg-zinc-800 text-zinc-100" : "border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
              }`}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-7">
        <h3 className="mb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Recent investigations</h3>
        {failed && <p className="text-xs text-red-300">Couldn&apos;t load investigations.</p>}
        {!lists && !failed && <p className="text-xs text-zinc-600">Loading…</p>}
        {lists && lists.recent.length === 0 && lists.samples.length === 0 && <p className="text-xs text-zinc-600">None yet. Runs you start are saved here.</p>}
        {lists && (
          <div className="-mx-3 space-y-0.5">
            {lists.recent.slice(0, 6).map((inv) => (
              <InvestigationRow key={inv.id} inv={inv} active={false} onOpen={onOpen} />
            ))}
            {lists.samples.map((inv) => (
              <InvestigationRow key={inv.id} inv={inv} active={false} onOpen={onOpen} />
            ))}
          </div>
        )}
        {lists && lists.recent.length > 6 && <p className="mt-1 text-xs text-zinc-600">More in the Investigations menu.</p>}
      </div>
    </div>
  );
}
