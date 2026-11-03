"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInvestigation } from "@/lib/client/useInvestigation";
import { Brief, ExportButton } from "./components/Brief";
import { Trace } from "./components/Trace";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import { HistoryMenu } from "./components/History";
import { EmptyState } from "./components/EmptyState";
import { RunPill } from "./components/RunPill";
import { ActionDialog } from "./components/ActionDialog";
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


export default function Home() {
  const { state, info, running, progress, reset, load, act, stop, error, errorCode, clearError, start, followUp, latestRevision, dismissRevision } = useInvestigation();
  const followUpInput = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<"resolve" | "reopen" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
  const runIncident = () => {
    if (!incident.trim() || running) return;
    // Replay can only reproduce the recorded incident; don't pretend to investigate anything else.
    if (sample && !matchesRecordedIncident(incident, sample.incidentInput)) return setReplayBlocked(true);
    setReplayBlocked(false);
    start(incident.trim());
  };

  const busy = running || state?.status === "running";
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
          ) : null}

          {state && (
            <div className="-mt-2 mb-3 flex justify-end gap-2" data-testid="brief-toolbar">
              {!followUpLocked &&
                (state.incidentStatus === "resolved" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDialog("reopen")}
                    className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    Reopen
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDialog("resolve")}
                    title={busy ? "Available when the agent finishes" : "Resolve the incident (records your comment as evidence)"}
                    className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
                  >
                    Resolve
                  </button>
                ))}
              <ExportButton state={state} />
            </div>
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

          {!state && !running ? (
            <EmptyState
              incident={incident}
              setIncident={(v) => {
                setIncident(v);
                if (replayBlocked && sample && matchesRecordedIncident(v, sample.incidentInput)) setReplayBlocked(false);
              }}
              onRun={runIncident}
              running={running}
              replaySample={sample?.incidentInput ?? null}
              onOpen={openInvestigation}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
              <div className="min-w-0">
                {state ? (
                  <>
                    {(running || state.status === "running") && (
                      <div className="mb-3">
                        <RunPill steps={state.trace} progress={progress} followUp={state.revisions.length > 0 || (progress?.baseStep ?? 0) > 0} onStop={stop} />
                      </div>
                    )}
                    <Brief
                      state={state}
                      changed={changed}
                      onQuestion={askAbout}
                    />
                  </>
                ) : (
                  <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-16 text-center text-sm text-zinc-400">Starting the investigation…</div>
                )}
              </div>
              <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-5rem)]">
                <Trace steps={state?.trace ?? []} running={running} progress={progress} />
              </div>
            </div>
          )}
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

        {state && !followUpLocked && (
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
            {!busy && (suggestions.length > 0 || nextSampleFollowUp) && (
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
            {actionError && <p className="mx-auto max-w-[1600px] px-4 pt-2 text-sm text-red-300">{actionError}</p>}
            <form
              className="mx-auto flex max-w-[1600px] flex-wrap gap-2 px-4 py-2.5 sm:flex-nowrap"
              onSubmit={(e) => {
                e.preventDefault();
                if (!message.trim() || busy) return;
                if (replayedRun && (!nextSampleFollowUp || !matchesRecordedIncident(message, nextSampleFollowUp))) return setFollowUpBlocked(true);
                setFollowUpBlocked(false);
                setActionError(null);
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
                disabled={busy}
                onChange={(e) => {
                  setMessage(e.target.value);
                  if (followUpBlocked && nextSampleFollowUp && matchesRecordedIncident(e.target.value, nextSampleFollowUp)) setFollowUpBlocked(false);
                }}
                placeholder={
                  busy
                    ? "The agent is working. Follow-ups and notes unlock when it finishes (or press Stop)."
                    : "Answer an open question or paste new evidence (e.g. “Marcus confirms he changed the pool”)"
                }
                className="min-w-0 flex-1 basis-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:basis-auto"
              />
              <button
                type="button"
                disabled={busy || !message.trim()}
                title="Record as evidence without rerunning the agent"
                onClick={async () => {
                  setActionError(null);
                  const r = await act("note", message.trim());
                  if (r.ok) setMessage("");
                  else setActionError(r.error);
                }}
                className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add note
              </button>
              <button
                type="submit"
                disabled={busy || !message.trim()}
                title="Rerun the agent with this information"
                className="rounded-md border border-zinc-600 bg-zinc-800 px-4 py-2 text-sm text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send follow-up
              </button>
            </form>
          </footer>
        )}
      </div>
      <EvidenceDrawer id={evidenceId} investigationId={state?.id} onClose={closeDrawer} />
      {dialog && state && (
        <ActionDialog
          mode={dialog}
          status={state.incidentStatus}
          onClose={() => setDialog(null)}
          onSubmit={async (comment, confirm) => {
            const r = await act(dialog, comment || undefined, confirm);
            return r.ok ? null : r.error;
          }}
        />
      )}
    </EvidenceContext.Provider>
  );
}
