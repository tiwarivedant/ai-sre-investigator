"use client";

import { useState } from "react";
import type { Hypothesis, InvestigationState, NextAction } from "@/lib/types";
import { briefToMarkdown } from "@/lib/brief/markdown";
import { revisionLabel } from "@/lib/text";
import { IncidentChart, useChartData } from "./IncidentChart";
import { whatToProvide, type Coverage } from "@/lib/analysis/coverage";
import { Chips, confidenceWord, ConfidenceBar, EvidenceChip, HypothesisStatus, RichText, RiskBadge, RunStatus, Section } from "./ui";

export function Brief({
  state,
  changed,
  onQuestion,
}: {
  state: InvestigationState;
  changed: Set<string>;
  onQuestion: (q: string) => void;
}) {
  const empty = !state.summary && state.hypotheses.length === 0;
  const running = state.status === "running";
  const now = state.nextActions.filter((a) => a.phase === "now");
  const later = state.nextActions.filter((a) => a.phase === "after_recovery");
  const prevention = state.nextActions.filter((a) => a.phase === "prevention");
  const repeat = state.repeatIncident;
  const chart = useChartData();

  return (
    <div className="space-y-3">
      {state.coverage && <CoverageAnswer coverage={state.coverage} />}
      {(state.otherActiveIssues?.length ?? 0) > 0 && <OtherActiveIssues issues={state.otherActiveIssues!} />}
      {state.briefSource !== "pre-analysis" && <StatusStepper state={state} />}
      {(state.ignoredFollowUps?.length ?? 0) > 0 && (
        <div role="note" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400">
          <span className="font-semibold tracking-wider text-zinc-300 uppercase">Ignored follow-up{state.ignoredFollowUps!.length > 1 ? "s" : ""}</span>
          {state.ignoredFollowUps!.map((f) => (
            <span key={f.evidenceId} className="min-w-0" title={f.text}>
              <EvidenceChip id={f.evidenceId} variant="inline" /> instruction-like text, not treated as evidence: &ldquo;
              {f.text.length > 70 ? `${f.text.slice(0, 69)}…` : f.text}&rdquo;
            </span>
          ))}
        </div>
      )}
      <Verdict state={state} />

      {(state.untestedSuspects?.length ?? 0) > 0 && state.status !== "running" && (
        <div role="alert" data-testid="untested-suspects" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          <span className="font-semibold">Untested suspects: {state.untestedSuspects!.join(", ")}.</span> Changes made shortly before onset or named by
          responders that no hypothesis supports or rules out. Check them before trusting the likely cause.
        </div>
      )}
      {(state.consistencyIssues?.length ?? 0) > 0 && state.status !== "running" && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          <span className="font-semibold">Check this brief:</span> {state.consistencyIssues!.join("; ")}.
        </div>
      )}

      {state.statusReason && state.status !== "running" && (
        <div className={`rounded-md border px-3 py-2 text-sm ${state.status === "error" ? "border-red-500/40 bg-red-500/10 text-red-200" : "border-amber-500/40 bg-amber-500/10 text-amber-100"}`}>
          {state.statusReason}
        </div>
      )}

      {empty && running ? (
        <div className="space-y-3" data-testid="brief-skeleton">
          <SkeletonSection title="Summary" lines={3} />
          <SkeletonSection title="Hypotheses" cards={2} />
          <SkeletonSection title="Next actions" lines={3} />
          <SkeletonSection title="Timeline (UTC)" lines={4} />
        </div>
      ) : empty ? (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">No brief was written.</div>
      ) : (
        <>
          {state.briefSource === "pre-analysis" && (
            <div className="rounded-md border border-zinc-600 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-200">
              <span className="font-semibold">Pre-analysis only.</span> The agent did not finish, so this brief lists what code measured
              (onset, changes, saturation, noise flags). No root cause has been judged and no actions are recommended. Run the investigation again.
            </div>
          )}

          <Section title="Summary">
            <p className="text-sm leading-relaxed text-zinc-200"><RichText text={state.summary} /></p>
            {state.impact && (
              <p className="mt-3 border-t border-zinc-800 pt-3 text-sm leading-relaxed text-zinc-300">
                <span className="mr-2 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Impact</span>
                <RichText text={state.impact} />
              </p>
            )}
          </Section>

          {repeat && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2.5">
              <div className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-semibold text-rose-200">Repeat incident.</span>
                <span className="text-zinc-200">
                  <EvidenceChip id={repeat.incidentId} /> had the same failure, and its action items are still open:
                </span>
              </div>
              <ul className="mt-1.5 space-y-0.5 text-sm text-zinc-300">
                {repeat.openActionItems.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="text-rose-300">☐</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {state.hypotheses.length === 0 && running && <SkeletonSection title="Hypotheses" cards={2} />}
          {state.hypotheses.length > 0 && (
            <Section title={`Hypotheses (${state.hypotheses.length})`}>
              <div className="space-y-2">
                {state.hypotheses.map((h, i) => (
                  <HypothesisCard key={h.id} h={h} rank={i + 1} highlight={changed.has(h.id)} />
                ))}
              </div>
              {(state.unexplained?.length ?? 0) > 0 && (
                <div className="mt-3 rounded-md border border-dashed border-zinc-700 px-3 py-2">
                  <div className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Not yet explained</div>
                  <p className="mt-0.5 text-xs text-zinc-500">Anomalies no hypothesis, key signal, or noise entry accounts for (checked by code).</p>
                  <ul className="mt-1.5 space-y-1">
                    {state.unexplained!.map((u) => (
                      <li key={u.evidenceId} className="text-sm text-zinc-300">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <EvidenceChip id={u.evidenceId} />
                          <span className="text-xs text-zinc-400">{u.what}</span>
                        </div>
                        {u.related.length > 0 && (
                          <ul className="mt-1 space-y-0.5 border-l-2 border-zinc-800 pl-2">
                            <li className="text-[11px] text-zinc-500">Possibly related (for a human to judge):</li>
                            {u.related.map((r) => (
                              <li key={r.evidenceId} className="flex flex-wrap items-baseline gap-2 text-xs text-zinc-400">
                                <EvidenceChip id={r.evidenceId} />
                                <span className="min-w-0">{r.why}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Section>
          )}

          {(state.similarIncidents?.length ?? 0) > 0 && (
            <Section title="Similar past incidents">
              <ul className="space-y-2.5">
                {state.similarIncidents!.map((x) => (
                  <li key={x.incidentId} className="text-sm">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <EvidenceChip id={x.incidentId} />
                      <span className="text-zinc-200"><RichText text={x.similarity} /></span>
                      {x.source === "retrieval" && <span className="text-[10px] tracking-wide text-zinc-500 uppercase">matched by retrieval</span>}
                    </div>
                    {x.lesson && (
                      <p className="mt-1 border-l-2 border-zinc-700 pl-2 text-zinc-400">
                        <span className="text-zinc-500">Lesson: </span>
                        <RichText text={x.lesson} />
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {(state.contributingFactors?.length ?? 0) > 0 && (
            <Section title="Contributing factors">
              <p className="mb-2 text-xs text-zinc-500">Not the trigger: the conditions that let it become an incident, or made it worse or slower to resolve.</p>
              <ul className="space-y-1.5">
                {state.contributingFactors!.map((f, i) => (
                  <li key={`${f.factor}-${i}`} className="flex gap-2 text-sm text-zinc-300">
                    <span className="text-zinc-600">•</span>
                    <span className="min-w-0 flex-1">
                      <RichText text={f.factor} /> <Chips ids={f.evidence.filter((id) => !f.factor.includes(id))} empty="" />
                      {f.source === "code" && <span className="ml-1 text-[10px] tracking-wide text-zinc-500 uppercase">derived from data</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {state.nextActions.length === 0 && running && <SkeletonSection title="Next actions" lines={3} />}
          {(now.length > 0 || later.length > 0 || prevention.length > 0 || (state.doneActions?.length ?? 0) > 0) && (
            <Section title="Next actions">
              <ActionList actions={now} />
              {later.length > 0 && (
                <div className={now.length ? "mt-4 border-t border-zinc-800 pt-3" : ""}>
                  <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">After recovery is verified</h3>
                  <ActionList actions={later} muted />
                </div>
              )}
              {prevention.length > 0 && (
                <div className={now.length || later.length ? "mt-4 border-t border-zinc-800 pt-3" : ""}>
                  <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Prevent recurrence (post-incident)</h3>
                  <ActionList actions={prevention} muted />
                </div>
              )}
              {(state.doneActions?.length ?? 0) > 0 && (
                <div className="mt-4 border-t border-zinc-800 pt-3">
                  <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Done</h3>
                  <ul className="space-y-1.5">
                    {state.doneActions!.map((d) => (
                      <li key={d.action} className="flex flex-wrap items-baseline gap-2 text-sm text-zinc-500">
                        <span className="text-emerald-400">✓</span>
                        <span className="min-w-0 flex-1 line-through decoration-zinc-700">
                          <RichText text={d.action} />
                        </span>
                        <span className="text-xs">per</span>
                        <Chips ids={d.evidence} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Section>
          )}

          {state.openQuestions.length > 0 && (
            <Section title="Open questions">
              <ul className="space-y-1.5 text-sm text-zinc-300">
                {state.openQuestions.map((q) => (
                  <li key={q}>
                    <button
                      type="button"
                      onClick={() => onQuestion(q)}
                      title="Answer this in the follow-up box"
                      className="group flex w-full gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-800/60"
                    >
                      <span className="text-amber-400">?</span>
                      <span className="min-w-0 flex-1">{q}</span>
                      <span className="shrink-0 self-center text-[11px] text-zinc-600 group-hover:text-zinc-300">Answer ↵</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {state.timeline.length === 0 && running && <SkeletonSection title="Timeline (UTC)" lines={4} />}
          {state.timeline.length > 0 && (
            <Section title="Timeline (UTC)">
              {chart && chart.series.length > 0 && <IncidentChart data={chart} />}
              <ol className="space-y-1">
                {state.timeline.map((t, i) => (
                  <li key={`${t.evidenceId}-${i}`} className="grid grid-cols-[3.75rem_minmax(0,1fr)] items-baseline gap-2 text-sm">
                    {t.evidenceId.startsWith("USER-") ? (
                      <span className="text-[10px] font-semibold tracking-wide text-yellow-300/80 uppercase" title={`Sent ${new Date(t.ts).toLocaleString()}`}>
                        follow-up
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-zinc-500 tabular-nums">{t.ts.slice(11, 16)}</span>
                    )}
                    <span className={t.kind === "ruled-out" ? "text-zinc-500" : "text-zinc-300"}>
                      <EvidenceChip id={t.evidenceId} /> <RichText text={t.note} />
                      {t.kind === "ruled-out" && <span className="ml-1.5 text-[10px] tracking-wide text-zinc-500 uppercase">ruled out</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <Section title="Key signals">
              {state.keySignals.length > 0 && state.keySignals.every((k) => k.source === "code") && (
                <p className="mb-2 text-xs text-zinc-500">The agent listed none; showing the leading hypothesis&apos;s evidence.</p>
              )}
              <SignalList items={state.keySignals} empty="None recorded." />
            </Section>
            <Section title="Noise (ruled out)">
              <SignalList items={state.noise} empty="None recorded." muted />
              {(state.notNoise?.length ?? 0) > 0 && (
                <div className="mt-3 border-t border-zinc-800 pt-2">
                  <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Flagged, but kept as signal</h3>
                  <SignalList items={state.notNoise!} empty="" />
                </div>
              )}
            </Section>
          </div>

          {state.stakeholderUpdate && (
            <Section title="Stakeholder update" aside={<CopyButton text={state.stakeholderUpdate} />}>
              <p className="text-sm leading-relaxed text-zinc-200">{state.stakeholderUpdate}</p>
            </Section>
          )}

          {state.groundingIssues.length > 0 && (
            <Section title="Grounding guard">
              <ul className="space-y-1 font-mono text-xs text-amber-200/80">
                {state.groundingIssues.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </Section>
          )}

          {state.revisions.length > 0 && (
            <Section title="Revisions">
              <ul className="space-y-2 text-xs text-zinc-400">
                {state.revisions.map((r) => (
                  <li key={r.at}>
                    <div className="text-zinc-500">
                      {new Date(r.at).toLocaleTimeString()} · <RichText text={revisionLabel(r.trigger)} />
                    </div>
                    <div className="mt-0.5 text-zinc-300">{r.changes.join(" · ")}</div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function HypothesisCard({ h, rank, highlight }: { h: Hypothesis; rank: number; highlight: boolean }) {
  if (h.status === "rejected") return <RejectedCard h={h} rank={rank} highlight={highlight} />;
  return (
    <article className={`rounded-md border p-3 transition-colors ${highlight ? "border-amber-400/60 bg-amber-400/5" : "border-zinc-800 bg-zinc-950/40"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-zinc-500">#{rank}</span>
        <span className="font-mono text-xs font-semibold text-zinc-300">{h.id}</span>
        <HypothesisStatus status={h.status} />
        {highlight && <span className="text-[10px] font-semibold tracking-wide text-amber-300 uppercase">changed</span>}
        <div className="ml-auto w-28 sm:w-36">
          <ConfidenceBar value={h.confidence} label={`Confidence in ${h.id}`} />
        </div>
      </div>
      <p className="mt-2 text-sm font-medium text-zinc-100">
        <RichText text={h.statement} />
      </p>
      <dl className="mt-2 grid gap-1.5 text-xs sm:grid-cols-[6.5rem_1fr]">
        <dt className="text-zinc-500">Supporting</dt>
        <dd><Chips ids={h.supporting} tone="support" /></dd>
        <dt className="text-zinc-500">Contradicting</dt>
        <dd><Chips ids={h.contradicting} tone="contra" /></dd>
      </dl>
      <details className="group mt-2">
        <summary className="cursor-pointer text-xs text-zinc-500 select-none hover:text-zinc-300">Reasoning</summary>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-300"><RichText text={h.reasoning} /></p>
      </details>
    </article>
  );
}

/** First sentence of the reasoning: why it was ruled out, in one line. */
function rejectionReason(h: Hypothesis): string {
  const first = h.reasoning.match(/^.+?[.!?](\s|$)/s)?.[0].trim() ?? h.reasoning;
  return first.length > 220 ? `${first.slice(0, 219)}…` : first;
}

/** Ruled-out hypotheses stay visible (they show what was checked) but quiet. */
function RejectedCard({ h, rank, highlight }: { h: Hypothesis; rank: number; highlight: boolean }) {
  return (
    <article className={`rounded-md border px-3 py-2 ${highlight ? "border-amber-400/40 bg-amber-400/5" : "border-zinc-800/70 bg-zinc-950/20"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-zinc-600">#{rank}</span>
        <span className="font-mono text-xs text-zinc-500">{h.id}</span>
        <HypothesisStatus status={h.status} />
        {highlight && <span className="text-[10px] font-semibold tracking-wide text-amber-300 uppercase">changed</span>}
        <span className="min-w-0 flex-1 text-sm text-zinc-400"><RichText text={h.statement} /></span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        <span className="text-zinc-400">Ruled out: </span>
        <RichText text={rejectionReason(h)} />
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-zinc-600 select-none hover:text-zinc-400">Evidence</summary>
        <dl className="mt-1.5 grid gap-1.5 text-xs sm:grid-cols-[6.5rem_1fr]">
          <dt className="text-zinc-600">Supporting</dt>
          <dd><Chips ids={h.supporting} /></dd>
          <dt className="text-zinc-600">Contradicting</dt>
          <dd><Chips ids={h.contradicting} tone="contra" /></dd>
        </dl>
      </details>
    </article>
  );
}

const SOURCE_LABEL: Record<string, string> = { catalog: "service catalog", alerts: "alerts", logs: "logs", metrics: "metrics", changes: "changes", "follow-ups": "follow-ups" };

/** The answer to "does the data even cover this?", before anything else. */
function CoverageAnswer({ coverage }: { coverage: Coverage }) {
  const found = coverage.terms.filter((t) => t.covered && t.kind === "component");
  const searched = coverage.searched.map((s) => SOURCE_LABEL[s] ?? s).join(", ");
  if (coverage.verdict === "covered") {
    return (
      <p className="px-1 text-xs text-zinc-500">
        <span className="font-semibold tracking-wider text-zinc-400 uppercase">Coverage</span>{" "}
        Reported {found.length ? found.map((t) => t.term.replace(/-service$/, "")).join(", ") : "symptoms"} found in the data (
        {[...new Set(coverage.terms.flatMap((t) => Object.keys(t.hits)))].map((s) => SOURCE_LABEL[s] ?? s).join(", ")}).
      </p>
    );
  }
  const name = (t: string) => (t === "kafka" ? "Kafka" : t);
  return (
    <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <h2 className="text-[11px] font-semibold tracking-wider text-amber-300 uppercase">Answer</h2>
      <p className="mt-1 text-sm text-zinc-100">
        {coverage.verdict === "none" ? "No evidence" : "Partial evidence: nothing"} about{" "}
        <span className="font-semibold">{coverage.uncovered.map(name).join(", ")}</span> in the available data (searched {searched}).
        {found.length > 0 && <> Evidence covers {found.map((t) => t.term.replace(/-service$/, "")).join(", ")}.</>}
      </p>
      <ul className="mt-2 space-y-1 text-sm text-zinc-300">
        {[...new Set(coverage.uncovered.map((t) => whatToProvide(t)))].map((need, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-amber-300/80">→</span>
            <span>To investigate, provide {need}.</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Other incidents in the data: shown, clearly not as the answer. */
function OtherActiveIssues({ issues }: { issues: NonNullable<InvestigationState["otherActiveIssues"]> }) {
  return (
    <section className="rounded-lg border border-zinc-700 bg-zinc-900/40 px-4 py-3">
      <h2 className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Other active incident{issues.length > 1 ? "s" : ""}</h2>
      <ul className="mt-1.5 space-y-1.5">
        {issues.map((o) => (
          <li key={o.title} className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="text-zinc-200"><RichText text={o.title} /></span>
            <Chips ids={o.evidence} />
            <span className="text-xs text-zinc-500 italic">{o.relationship}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STEPS: { key: NonNullable<InvestigationState["incidentStatus"]>; label: string; criterion: string }[] = [
  { key: "investigating", label: "Investigating", criterion: "Gathering evidence; cause not yet confirmed by a human" },
  { key: "identified", label: "Identified", criterion: "A human confirmed the cause" },
  { key: "mitigated", label: "Mitigated", criterion: "A human reported recovery after the fix" },
  { key: "resolved", label: "Resolved", criterion: "A later report says the recovery held" },
];

/** Incident lifecycle, derived only from human evidence; reached steps show what got them there. */
function StatusStepper({ state }: { state: InvestigationState }) {
  const insufficient = state.incidentStatus === "insufficient-evidence";
  const current = insufficient ? 0 : STEPS.findIndex((st) => st.key === (state.incidentStatus ?? "investigating"));
  const lead = state.hypotheses.find((h) => h.status !== "rejected");
  const proof: Record<string, string[]> = {
    identified: (lead?.supporting ?? []).filter((id) => id.startsWith("USER-")).slice(0, 1),
    mitigated: (lead?.recoveryEvidence ?? []).filter((id) => id.startsWith("USER-")).slice(0, 1),
    resolved: state.incidentStatus === "resolved" ? state.timeline.filter((t) => t.kind === "follow-up").slice(-1).map((t) => t.evidenceId) : [],
  };
  return (
    <ol aria-label="Incident status" className="flex items-start gap-1 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      {STEPS.map((st, i) => {
        // The last step, once reached, is complete rather than in progress.
        const done = i < current || (i === current && i === STEPS.length - 1);
        const active = i === current && !done;
        return (
          <li key={st.key} className="flex min-w-0 flex-1 items-start gap-1" aria-current={active ? "step" : undefined}>
            <div className="flex min-w-0 flex-col" title={st.criterion}>
              <div className="flex items-center gap-1.5">
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold ${
                    insufficient && i === 0
                      ? "border-amber-400/60 bg-amber-500/15 text-amber-200"
                      : active
                      ? "border-sky-300 bg-sky-400/20 text-sky-100"
                      : done
                        ? "border-emerald-400/60 bg-emerald-500/15 text-emerald-200"
                        : "border-zinc-700 text-zinc-600"
                  }`}
                >
                  {insufficient && i === 0 ? "!" : done ? "✓" : i + 1}
                </span>
                <span className={`text-xs font-medium whitespace-nowrap ${insufficient && i === 0 ? "text-amber-200" : active ? "text-zinc-50" : done ? "text-zinc-300" : "text-zinc-600"}`}>
                  {insufficient && i === 0 ? "Insufficient evidence" : st.label}
                </span>
              </div>
              {(done || active) && proof[st.key]?.length ? (
                <span className="mt-0.5 ml-6 text-[10px] text-zinc-500">
                  per <EvidenceChip id={proof[st.key][0]} variant="inline" />
                </span>
              ) : null}
            </div>
            {i < STEPS.length - 1 && <span className={`mx-1 mt-2.5 h-px min-w-3 flex-1 ${i < current ? "bg-emerald-500/40" : "bg-zinc-800"}`} />}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The answer first: what most likely happened, how sure, what to do now, and
 * where the run stands. Everything below is the supporting brief.
 */
function Verdict({ state }: { state: InvestigationState }) {
  const lead = state.hypotheses.find((h) => h.status !== "rejected");
  const action = state.nextActions.find((a) => a.phase === "now");
  const preAnalysis = state.briefSource === "pre-analysis";
  const recoveryPending = lead?.status === "confirmed" && !lead.recoveryEvidence?.length;
  const humanConfirmation = lead?.supporting.find((id) => id.startsWith("USER-"));

  return (
    <section className="rounded-lg border border-zinc-700 bg-gradient-to-b from-zinc-900 to-zinc-900/40">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <RunStatus status={state.status} />
        <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">{state.id}</span>
        <div className="ml-auto">

        </div>
      </header>
      <div className="px-4 py-3">
        {state.incidentStatus === "insufficient-evidence" ? (
          <>
            <div className="text-[11px] font-semibold tracking-wider text-amber-300/90 uppercase">Insufficient evidence</div>
            <p className="mt-1 text-base leading-snug font-semibold text-zinc-50">
              The available data has nothing about {state.coverage?.uncovered.join(", ") || "the reported symptom"}, so there is no supported cause yet.
            </p>
            {action && (
              <div className="mt-3 flex flex-wrap items-baseline gap-2 border-t border-zinc-800 pt-2.5 text-sm">
                <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Do now</span>
                <RiskBadge risk={action.risk} reason={action.riskReason} />
                <span className="min-w-0 flex-1 text-zinc-200"><RichText text={action.action} /></span>
              </div>
            )}
          </>
        ) : preAnalysis || !lead ? (
          <p className="text-sm text-zinc-400">
            {state.status === "running" ? "Investigating. The verdict appears once the agent writes its first brief." : "No verdict: the agent did not reach a hypothesis."}
          </p>
        ) : (
          <>
            <div className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{lead.status === "confirmed" ? "Cause" : "Likely cause"}</div>
            <p className="mt-1 text-base leading-snug font-semibold text-zinc-50">
              <RichText text={lead.statement} />
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-zinc-200">
                {confidenceWord(lead.confidence, lead.status)} · <span className="font-mono tabular-nums">{Math.round(lead.confidence * 100)}%</span>
              </span>
              <div className="w-28">
                <ConfidenceBar value={lead.confidence} label={`Confidence in ${lead.id}`} showValue={false} />
              </div>
              {humanConfirmation && <span className="text-xs text-zinc-400">confirmed by <EvidenceChip id={humanConfirmation} variant="inline" /></span>}
              {recoveryPending && <span className="text-xs text-amber-300/90">recovery not yet verified</span>}
              {!humanConfirmation && <span className="text-xs text-zinc-500">not yet confirmed by a human</span>}
            </div>
            {action && (
              <div className="mt-3 flex flex-wrap items-baseline gap-2 border-t border-zinc-800 pt-2.5 text-sm">
                <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Do now</span>
                <RiskBadge risk={action.risk} reason={action.riskReason} />
                <span className="min-w-0 flex-1 text-zinc-200"><RichText text={action.action} /></span>
                {action.owner && <span className="text-xs text-zinc-500">{action.owner}</span>}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ActionList({ actions, muted }: { actions: NextAction[]; muted?: boolean }) {
  if (!actions.length) return <p className="text-sm text-zinc-500">None.</p>;
  return (
    <ol className="space-y-2">
      {actions.map((a, i) => (
        <li key={`${a.action}-${i}`} className={`flex gap-3 text-sm ${muted ? "text-zinc-400" : "text-zinc-200"}`}>
          <span className="mt-0.5 font-mono text-xs text-zinc-600">{i + 1}.</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start gap-2">
              {a.phase === "prevention" ? <PriorityBadge priority={a.priority ?? "P2"} /> : <RiskBadge risk={a.risk} reason={a.riskReason} />}
              <span className="min-w-0 flex-1"><RichText text={a.action} /></span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
              {a.owner && <span>owner: <span className="text-zinc-300">{a.owner}</span></span>}
              {a.phase !== "prevention" && <span className="italic">{a.riskReason}</span>}
              <Chips ids={a.evidence} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function PriorityBadge({ priority }: { priority: "P1" | "P2" }) {
  return (
    <span
      title={priority === "P1" ? "P1: prevents this exact failure recurring" : "P2: hardening"}
      className={`inline-flex shrink-0 rounded border px-1.5 py-px text-[10px] font-semibold tracking-wide ${priority === "P1" ? "border-violet-400/50 bg-violet-500/10 text-violet-200" : "border-zinc-600 bg-zinc-800 text-zinc-300"}`}
    >
      {priority}
    </span>
  );
}

function SignalList({ items, empty, muted }: { items: { evidenceId: string; why: string; source?: "agent" | "code"; flags?: string[] }[]; empty: string; muted?: boolean }) {
  if (!items.length) return <p className="text-sm text-zinc-500">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((s, i) => (
        <li key={`${s.evidenceId}-${i}`} className={`flex min-w-0 items-baseline gap-2 text-sm ${muted ? "text-zinc-400" : "text-zinc-300"}`}>
          <EvidenceChip id={s.evidenceId} />
          <span className="min-w-0 flex-1">
            {/* Agent reason when it gave one; the heuristic tag shows the flags that also mark it. */}
            {s.why ? <RichText text={s.why} /> : <span className="text-zinc-500">{(s.flags ?? []).join(" · ")}</span>}
            {s.flags && (
              <span className="ml-1.5 cursor-help text-[10px] tracking-wide text-zinc-600 uppercase" title={`Heuristic flags: ${s.flags.join(", ")}`}>
                heuristic
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function ExportButton({ state }: { state: InvestigationState }) {
  return (
    <button
      type="button"
      onClick={() => {
        const blob = new Blob([briefToMarkdown(state)], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), { href: url, download: `${state.id}-brief.md` });
        a.click();
        URL.revokeObjectURL(url);
      }}
      className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
    >
      Export Markdown
    </button>
  );
}

/** Placeholder for a section the agent hasn't written yet (shown while it runs). */
function SkeletonSection({ title, lines = 0, cards = 0 }: { title: string; lines?: number; cards?: number }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40" aria-busy="true" aria-label={`${title} (being written)`}>
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <h2 className="text-[11px] font-semibold tracking-wider text-zinc-600 uppercase">{title}</h2>
        <span className="text-[10px] text-zinc-600">being written…</span>
      </header>
      <div className="animate-pulse space-y-2 px-4 py-3">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="h-3 rounded bg-zinc-800" style={{ width: `${[92, 78, 85, 64][i % 4]}%` }} />
        ))}
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="space-y-2 rounded-md border border-zinc-800 p-3">
            <div className="h-3 w-1/3 rounded bg-zinc-800" />
            <div className="h-3 w-5/6 rounded bg-zinc-800" />
            <div className="h-3 w-2/3 rounded bg-zinc-800" />
          </div>
        ))}
      </div>
    </section>
  );
}
