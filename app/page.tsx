"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInvestigation } from "@/lib/client/useInvestigation";
import { Brief } from "./components/Brief";
import { Trace } from "./components/Trace";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import { HistoryMenu, SampleList } from "./components/History";
import { EvidenceContext } from "./components/ui";
import {
  expectedFollowUp,
  matchesRecordedIncident,
  REPLAY_FOLLOWUP_MISMATCH,
  REPLAY_MISMATCH,
  liveInReplayMessage,
  readOnlyMessage,
  replayFollowUpMessage,
  replayMismatchMessage,
} from "@/lib/replayGuard";

interface Config {
  provider: string;
  model: string;
  replay: boolean;
  fixture?: { label: string; incidentInput: string; followUps: string[] } | null;
  error?: string;
}

const EXAMPLE = "Customers are seeing errors at checkout and the site feels slow. Started maybe 15–20 min ago.";

export default function Home() {
  const { state, info, running, progress, reset, load, error, errorCode, clearError, start, followUp, latestRevision, dismissRevision } = useInvestigation();
  const followUpInput = useRef<HTMLInputElement>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  // Live mode starts empty (prefilled text looks like a real, stale incident); replay mode
  // prefills the recorded sample once config arrives, since it is the only input replay accepts.
  const [incident, setIncident] = useState("");
  const [message, setMessage] = useState("");
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [replayBlocked, setReplayBlocked] = useState(false);
  const sample = config?.replay ? config.fixture : null;
  const [followUpBlocked, setFollowUpBlocked] = useState(false);
  // A replayed investigation can only take its recorded follow-ups, in order (one revision per follow-up sent).
  const replayedRun = info?.provider === "replay" && sample;
  const nextSampleFollowUp = replayedRun && state ? expectedFollowUp(sample.followUps, state.revisions.length) : null;

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c: Config) => {
        setConfig(c);
        if (c.replay && c.fixture) setIncident((cur) => cur || c.fixture!.incidentInput); // never overwrite typing
      })
      .catch(() => {});
  }, []);

  /** What a fresh input box holds: the recorded sample in replay, nothing in live mode. */
  const freshIncident = () => (sample ? sample.incidentInput : "");

  const changed = useMemo(
    () => new Set((latestRevision?.changes ?? []).map((c) => c.match(/^(H\d+)\b/)?.[1]).filter((x): x is string => !!x)),
    [latestRevision],
  );
  const closeDrawer = useCallback(() => setEvidenceId(null), []);

  // Clicking an open question (in the brief or as a chip) starts an answer in the follow-up box.
  const askAbout = useCallback((q: string) => {
    setMessage(`Re: ${q} — `);
    setFollowUpBlocked(false);
    requestAnimationFrame(() => {
      const el = followUpInput.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);
  const suggestions = state?.status !== "running" ? (state?.openQuestions ?? []).slice(0, 3) : [];

  const openInvestigation = useCallback(
    (id: string) => {
      load(id);
      setMessage("");
      setFollowUpBlocked(false);
      setReplayBlocked(false);
      setChangesOpen(false);
    },
    [load],
  );
  // Why follow-ups are unavailable for the loaded investigation, if they are.
  const followUpLocked = info?.sample
    ? readOnlyMessage()
    : config?.replay && info && info.provider !== "replay"
      ? liveInReplayMessage(info.provider)
      : null;

  return (
    <EvidenceContext.Provider value={setEvidenceId}>
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2.5">
            <div className="size-2 rounded-full bg-emerald-400" />
            <h1 className="text-sm font-semibold tracking-tight whitespace-nowrap">Incident Investigator</h1>
            <span className="hidden text-xs text-zinc-500 sm:inline">evidence-cited briefs</span>
            <div className="ml-auto flex min-w-0 items-center gap-2 text-[11px]">
              <HistoryMenu activeId={state?.id} onOpen={openInvestigation} />
              {config?.replay && (
                <span
                className="cursor-help rounded border border-fuchsia-400/40 bg-fuchsia-500/10 px-1.5 py-px font-semibold tracking-wide text-fuchsia-200 uppercase"
                title={`Model turns come from a recorded fixture; tools, grounding and policy run live.${sample ? `\n\nRecorded incident (${sample.label}):\n"${sample.incidentInput}"` : ""}`}
              >
                  Replay
                </span>
              )}
              {config && !config.error && (
                <span className="hidden truncate font-mono text-zinc-500 sm:inline">
                  {info?.provider ?? config.provider} · {info?.model ?? config.model}
                </span>
              )}
              {config?.error && <span className="text-red-300">{config.error}</span>}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-4">
          {state ? (
            <div className="mb-4 flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2">
              <span className="shrink-0 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Incident</span>
              {info?.sample && (
                <span
                  className="shrink-0 cursor-help rounded border border-sky-400/40 bg-sky-500/10 px-1.5 py-px text-[10px] font-semibold tracking-wide text-sky-200 uppercase"
                  title={`Read-only sample. Model turns recorded from ${info.recordedFrom ?? "a live run"}.`}
                >
                  Sample
                </span>
              )}
              <p className="min-w-0 flex-1 truncate text-sm text-zinc-300" title={state.incidentInput}>
                {state.incidentInput}
              </p>
              <button
                type="button"
                disabled={running}
                onClick={() => {
                  reset();
                  setIncident(freshIncident());
                  setMessage("");
                  setFollowUpBlocked(false);
                  setReplayBlocked(false);
                }}
                className="shrink-0 rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                New investigation
              </button>
            </div>
          ) : (
          <form
            className="mb-4 flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!incident.trim() || running) return;
              // Replay can only reproduce the recorded incident; don't pretend to investigate anything else.
              if (sample && !matchesRecordedIncident(incident, sample.incidentInput)) return setReplayBlocked(true);
              setReplayBlocked(false);
              start(incident.trim());
            }}
          >
            <label htmlFor="incident" className="sr-only">
              Describe the incident
            </label>
            <div className="relative flex-1">
              <textarea
                id="incident"
                rows={2}
                value={incident}
                onChange={(e) => {
                  setIncident(e.target.value);
                  if (replayBlocked && sample && matchesRecordedIncident(e.target.value, sample.incidentInput)) setReplayBlocked(false);
                }}
                placeholder="What are responders seeing, and since when? (symptoms, affected users, rough start time)"
                className="block min-h-[2.75rem] w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 pr-28 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
              />
              {!incident.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    setIncident(sample ? sample.incidentInput : EXAMPLE);
                    setReplayBlocked(false);
                  }}
                  className="absolute right-2 bottom-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
                >
                  Use example
                </button>
              )}
            </div>
            <button
              type="submit"
              disabled={running || !incident.trim()}
              className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 sm:self-stretch"
            >
              {running ? "Investigating…" : "Run investigation"}
            </button>
          </form>
          )}

          {(replayBlocked || errorCode === REPLAY_MISMATCH) && (
            <div role="status" className="mb-4 flex flex-col gap-2 rounded-md border border-fuchsia-400/40 bg-fuchsia-500/5 px-3 py-2.5 sm:flex-row sm:items-center">
              <p className="flex-1 text-sm text-fuchsia-100">
                {errorCode === REPLAY_MISMATCH && error ? error : replayMismatchMessage(sample?.label ?? "the sample incident")}
              </p>
              {sample && (
                <button
                  type="button"
                  onClick={() => {
                    setIncident(sample.incidentInput);
                    setReplayBlocked(false);
                    clearError();
                  }}
                  className="shrink-0 rounded-md border border-fuchsia-400/50 px-3 py-1.5 text-sm text-fuchsia-100 hover:bg-fuchsia-500/10"
                >
                  Load sample incident
                </button>
              )}
            </div>
          )}

          {error && errorCode !== REPLAY_MISMATCH && errorCode !== REPLAY_FOLLOWUP_MISMATCH && (
            <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>
          )}

          {latestRevision && (
            <div className="mb-4 rounded-md border border-amber-400/30 bg-amber-400/5 text-sm">
              <div className="flex items-center gap-3 px-3 py-1.5">
                <span className="shrink-0 text-[11px] font-semibold tracking-wider text-amber-300 uppercase">What changed</span>
                <span className="min-w-0 flex-1 truncate text-zinc-300">
                  {latestRevision.changes.slice(0, 2).join(" · ")}
                  {latestRevision.changes.length > 2 && <span className="text-zinc-500"> · +{latestRevision.changes.length - 2} more</span>}
                </span>
                {latestRevision.changes.length > 2 && (
                  <button type="button" onClick={() => setChangesOpen((o) => !o)} className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200">
                    {changesOpen ? "Hide" : "Details"}
                  </button>
                )}
                <button type="button" onClick={dismissRevision} aria-label="Dismiss" className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300">
                  ✕
                </button>
              </div>
              {changesOpen && (
                <ul className="space-y-0.5 border-t border-amber-400/20 px-3 py-1.5 text-zinc-300">
                  {latestRevision.changes.map((c) => (
                    <li key={c}>• {c}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
            <div className="min-w-0">
              {state ? (
                <Brief state={state} changed={changed} onQuestion={askAbout} />
              ) : (
                <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-16 text-center">
                  <p className="text-sm text-zinc-300">Describe the incident and run an investigation.</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    The agent reads alerts, logs, deploys, config changes, metrics, runbooks and past incidents, and every claim it makes cites the evidence it rests on.
                  </p>
                  <SampleList onOpen={openInvestigation} />
                </div>
              )}
            </div>
            <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-5rem)]">
              <Trace steps={state?.trace ?? []} running={running} progress={progress} />
            </div>
          </div>
        </main>

        {state && state.status !== "running" && followUpLocked && (
          <footer className="sticky bottom-0 z-30 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
            <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2.5 text-sm">
              <span className="text-zinc-400">{followUpLocked}</span>
              {info?.sample && (
                <button
                  type="button"
                  onClick={() => {
                    reset();
                    setIncident(freshIncident());
                    setMessage("");
                  }}
                  className="ml-auto shrink-0 rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                >
                  New investigation
                </button>
              )}
            </div>
          </footer>
        )}

        {state && state.status !== "running" && !followUpLocked && (
          <footer className="sticky bottom-0 z-30 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
            {(followUpBlocked || errorCode === REPLAY_FOLLOWUP_MISMATCH) && sample && (
              <div role="status" className="mx-auto flex max-w-[1600px] flex-col gap-2 px-4 pt-2.5 sm:flex-row sm:items-center">
                <p className="flex-1 rounded-md border border-fuchsia-400/40 bg-fuchsia-500/5 px-3 py-2 text-sm text-fuchsia-100">
                  {replayFollowUpMessage(sample.label, nextSampleFollowUp)}
                </p>
                {nextSampleFollowUp && (
                  <button
                    type="button"
                    onClick={() => {
                      setMessage(nextSampleFollowUp);
                      setFollowUpBlocked(false);
                      clearError();
                    }}
                    className="shrink-0 rounded-md border border-fuchsia-400/50 px-3 py-1.5 text-sm text-fuchsia-100 hover:bg-fuchsia-500/10"
                  >
                    Load sample follow-up
                  </button>
                )}
              </div>
            )}
            {(suggestions.length > 0 || nextSampleFollowUp) && (
              <div className="mx-auto flex max-w-[1600px] gap-1.5 overflow-x-auto px-4 pt-2.5">
                {nextSampleFollowUp && (
                  <button
                    type="button"
                    onClick={() => {
                      setMessage(nextSampleFollowUp);
                      setFollowUpBlocked(false);
                      followUpInput.current?.focus();
                    }}
                    className="shrink-0 rounded-full border border-fuchsia-400/40 bg-fuchsia-500/5 px-2.5 py-0.5 text-xs text-fuchsia-100 hover:bg-fuchsia-500/10"
                    title="The follow-up recorded for replay"
                  >
                    {nextSampleFollowUp}
                  </button>
                )}
                {suggestions.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => askAbout(q)}
                    title={q}
                    className="max-w-[22rem] shrink-0 truncate rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-0.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
                  >
                    ? {q}
                  </button>
                ))}
              </div>
            )}
            <form
              className="mx-auto flex max-w-[1600px] gap-2 px-4 py-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!message.trim() || running) return;
                if (replayedRun && (!nextSampleFollowUp || !matchesRecordedIncident(message, nextSampleFollowUp))) return setFollowUpBlocked(true);
                setFollowUpBlocked(false);
                followUp(message.trim());
                setMessage("");
              }}
            >
              <label htmlFor="followup" className="sr-only">
                Follow-up
              </label>
              <input
                ref={followUpInput}
                id="followup"
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  if (followUpBlocked && nextSampleFollowUp && matchesRecordedIncident(e.target.value, nextSampleFollowUp)) setFollowUpBlocked(false);
                }}
                placeholder="Answer an open question or paste new evidence (e.g. “Marcus confirms he changed the pool”)"
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
              />
              <button
                type="submit"
                disabled={running || !message.trim()}
                className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send follow-up
              </button>
            </form>
          </footer>
        )}
      </div>
      <EvidenceDrawer id={evidenceId} investigationId={state?.id} onClose={closeDrawer} />
    </EvidenceContext.Provider>
  );
}
