"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InvestigationState, TraceStep } from "@/lib/types";
import { FOLLOWUP_BUDGET, INITIAL_BUDGET } from "@/lib/budget";

/** The run currently in progress, for the live "Turn X/N · Ns" readout. */
export interface RunProgress {
  startedAt: number;
  /** Last trace step number before this run began (follow-ups continue numbering). */
  baseStep: number;
  maxTurns: number;
}

const lastStep = (s: InvestigationState | null) => s?.trace.reduce((m, t) => Math.max(m, t.step), 0) ?? 0;

export interface RunInfo {
  provider: string;
  model: string;
  /** Shipped read-only example. */
  sample?: boolean;
  recordedFrom?: string;
}

/**
 * Owns one investigation on the client: starts runs and follow-ups, and keeps
 * a live SSE connection that delivers a snapshot, then trace and state events.
 * The investigation id lives in the URL (?id=) so a refresh re-attaches.
 */
export function useInvestigation() {
  const [state, setState] = useState<InvestigationState | null>(null);
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [lastRevisionAt, setLastRevisionAt] = useState<string | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const source = useRef<EventSource | null>(null);

  const connect = useCallback((id: string) => {
    source.current?.close();
    const es = new EventSource(`/api/investigations/${id}/stream`);
    source.current = es;
    setRunning(true);

    es.addEventListener("snapshot", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as { state: InvestigationState; provider: string; model: string; sample?: boolean; recordedFrom?: string };
      setState(d.state);
      setInfo({ provider: d.provider, model: d.model, sample: d.sample, recordedFrom: d.recordedFrom });
      // Re-attaching to a run already in progress (e.g. after a refresh): approximate its start.
      if (d.state.status === "running")
        setProgress(
          (p) =>
            p ?? {
              startedAt: Date.now(),
              baseStep: d.state.revisions.length ? lastStep(d.state) : 0,
              maxTurns: d.state.revisions.length ? FOLLOWUP_BUDGET.maxSteps : INITIAL_BUDGET.maxSteps,
            },
        );
    });
    es.addEventListener("trace", (ev) => {
      const step = JSON.parse((ev as MessageEvent).data) as TraceStep;
      // The server snapshots and subscribes in one synchronous step, so events never overlap the snapshot.
      setState((s) => (s ? { ...s, trace: [...s.trace, step] } : s));
    });
    es.addEventListener("state", (ev) => {
      const { state: next } = JSON.parse((ev as MessageEvent).data) as { state: InvestigationState };
      setState(next);
    });
    es.addEventListener("done", (ev) => {
      const { state: next } = JSON.parse((ev as MessageEvent).data) as { state: InvestigationState };
      setState(next);
      setRunning(false);
      setProgress(null);
      es.close();
    });
    es.onerror = () => {
      // EventSource retries on its own; if the server closed after "done" we already stopped.
      if (es.readyState === EventSource.CLOSED) setRunning(false);
    };
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) connect(id);
    return () => source.current?.close();
  }, [connect]);

  const start = useCallback(
    async (incident: string) => {
      setError(null);
      setErrorCode(null);
      setLastRevisionAt(null);
      setState(null);
      const res = await fetch("/api/investigations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incident }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErrorCode(body.code ?? null);
        return setError(body.error ?? `Failed to start (${res.status})`);
      }
      window.history.replaceState(null, "", `?id=${body.id}`);
      setProgress({ startedAt: Date.now(), baseStep: 0, maxTurns: INITIAL_BUDGET.maxSteps });
      connect(body.id);
    },
    [connect],
  );

  const followUp = useCallback(
    async (message: string) => {
      if (!state) return;
      setError(null);
      setErrorCode(null);
      const revisionsBefore = state.revisions.length;
      const res = await fetch(`/api/investigations/${state.id}/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErrorCode(body.code ?? null);
        return setError(body.error ?? `Follow-up failed (${res.status})`);
      }
      setLastRevisionAt(`pending:${revisionsBefore}`);
      setProgress({ startedAt: Date.now(), baseStep: lastStep(state), maxTurns: FOLLOWUP_BUDGET.maxSteps });
      connect(state.id);
    },
    [state, connect],
  );

  // Once the follow-up finishes, point the "What changed" banner at the new revision.
  const pending = lastRevisionAt?.startsWith("pending:") ? Number(lastRevisionAt.slice(8)) : null;
  useEffect(() => {
    if (pending !== null && !running && state && state.revisions.length > pending) {
      setLastRevisionAt(state.revisions[state.revisions.length - 1].at);
    }
  }, [pending, running, state]);

  const latestRevision = state?.revisions.find((r) => r.at === lastRevisionAt) ?? null;

  /** Open a saved investigation or sample: the stream's snapshot carries the full brief, trace and revisions. */
  const load = useCallback(
    (id: string) => {
      setError(null);
      setErrorCode(null);
      setLastRevisionAt(null);
      setProgress(null);
      setState(null);
      setInfo(null);
      window.history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
      connect(id);
    },
    [connect],
  );

  /** Back to a blank page for a new incident. */
  const reset = useCallback(() => {
    source.current?.close();
    setState(null);
    setInfo(null);
    setRunning(false);
    setProgress(null);
    setError(null);
    setErrorCode(null);
    setLastRevisionAt(null);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setErrorCode(null);
  }, []);

  return { state, info, running, progress, reset, load, error, errorCode, clearError, start, followUp, latestRevision, dismissRevision: () => setLastRevisionAt(null) };
}
