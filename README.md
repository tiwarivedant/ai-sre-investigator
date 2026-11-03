# Incident Investigator

An agentic incident investigation tool for on-call engineers. Describe a vague production problem ("checkout is erroring and the site feels slow"). The system investigates logs, alerts, metrics, deploys, config changes, runbooks, past incidents, and chat. It produces an **evidence-cited investigation brief** that keeps evolving as responders add information.

![Investigation brief: full incident lifecycle](samples/screenshots/01-brief-hero.png)

**The design principle in one line:** deterministic code computes facts, and the LLM makes judgments. Every claim cites evidence that a human can open in one click.

---

## Try it (pick one)

| Time | Option |
|---|---|
| **2 min** | Read the [sample outputs](#sample-outputs) and screenshots below |
| **5 min** | Run locally with **no API key** (replay mode + browsable sample investigations) |
| **10 min** | Run live with your own Anthropic or Gemini key and try your own prompts |

Requires **Node 22+**.

### Run locally (no key needed)

```bash
npm install
npm run dev:replay
# open http://localhost:3000
```

`npm run dev:replay` starts the app in **replay mode** (it sets `REPLAY=1` for you; no API key needed). On Windows, add `REPLAY=1` to `.env.local` and run `npm run dev` instead. Replay mode replays a recorded live investigation, including all follow-ups, and you can open the 5 sample investigations from the Recent list. Replay only supports the recorded sample incident; other prompts show a notice explaining that.

![Home screen with sample investigations](samples/screenshots/05-home.png)

### Run live

```bash
cp .env.example .env.local
# set ONE of:
#   ANTHROPIC_API_KEY=...   (default model: claude-sonnet-5-5)
#   GEMINI_API_KEY=...      (free tier works, but daily limits are low)
# optional: LLM_PROVIDER=anthropic|gemini
# leave REPLAY unset or 0: REPLAY=1 overrides LLM_PROVIDER
npm run dev
```

A live investigation took about 10 seconds in the eval runs; runs are capped at 90 seconds (follow-ups at 60).

### Tests and eval

```bash
npm test                 # 150 unit tests
npm run test:e2e         # 11 Playwright e2e tests in replay mode, no key needed (uses your installed Google Chrome)
npm run eval -- --runs 3 # live eval against the answer key
REPLAY=1 npm run eval    # eval against the recorded fixture, no key
```

---

## The scenario

**INC-2213:** checkout returns intermittent 500s and is slow, starting around 13:55 UTC during a promo.

The dataset (`data/`) is small but deliberately messy:

- **Red herring:** a payments deploy (`DEP-102`): canary at 13:40, 100% at 13:47, shortly before onset. Responders in the chat blame it and roll it back. Errors continue.
- **Real cause:** a hot-reloaded config change (`CFG-502`) at 13:52 raised inventory-service's DB pool from 20 to 80 across 6 replicas. That overcommits the shared orders-db (610 potential connections vs. a 400 limit) and starves orders-service. Config changes don't appear on the deploy dashboard, so it's easy to miss.
- **Noise:** five alerts: a log-host disk alert, a cert-expiry warning, a flapping search pod (two alerts), and reporting-job CPU.
- **Memory:** a past incident (`INC-2041`) had the *same* failure, and its action items (PgBouncer, a pool-size guardrail) are still open. A decoy past incident (`INC-1987`) is one where a payments deploy really was the cause.
- **Customer impact:** 87 tickets, including 14 "charged but no order" reports.

![Timeline: the payments deploy is 15 min before onset; the config change is 3 min before](samples/screenshots/02-timeline-chart.png)

| Input | IDs |
|---|---|
| Alerts | `ALR-001..014` |
| Logs (142 lines) | `LOG-001..142` |
| Deploys / config changes | `DEP-*`, `CFG-*` |
| Metrics (5-min buckets) | `MET-<series>` |
| Service catalog (deps, owners, DB budgets) | `services.yaml` |
| Runbooks / past incidents | `RB-*`, `INC-*` |
| Incident chat / customer notes | `CHAT-*`, `CUST-*` |
| Responder follow-ups | `USER-*` |

---

## What it produces

For each investigation, the brief includes:

- **Answer / coverage:** whether the evidence actually covers what was asked
- **Summary and impact**, with an incident status: *Investigating -> Identified -> Mitigated -> Resolved* (or *Insufficient evidence*)
- **Ranked hypotheses** with confidence, supporting **and** contradicting evidence, and reasoning. Rejected hypotheses stay visible with the reason.
- **Repeat-incident detection** and similar past incidents, with their lessons
- **Contributing factors** (e.g., open action items from past incidents)
- **Timeline**, **key signals**, and **noise ruled out** (with reasons)
- **Next actions** with risk level and owner, split into *now*, *after recovery is verified*, and *prevent recurrence*
- **Open questions** and a **stakeholder update** ready to paste
- **Revisions:** what changed after each follow-up
- **Live agent trace:** every tool call the agent made

Responders can send follow-ups (the agent re-investigates from the existing state), add notes, and resolve or reopen incidents.

![Next actions with risk rubric, after-recovery and prevention items](samples/screenshots/03-actions.png)

![Revisions: what changed after each follow-up](samples/screenshots/04-revisions.png)

---

## Architecture

![Architecture: deterministic layer, agent, guards and state](samples/screenshots/architecture.png)

```
Incident text / follow-ups
        |
        V
[1] Ingest + normalize (deterministic)   -> evidence store, every item has a stable ID
[2] Pre-analysis (deterministic)         -> timeline, metric change-points, change correlation,
                                           noise heuristics, coverage check, suspect changes
        |
        V
[3] Agent loop (LLM + read-only tools)   -> max 10 turns, time budget, writes state as it goes
        |
        V
[4] Guards (deterministic)               -> schema validation, citation check, confidence caps,
                                           risk rubric, finalize gate
        |
        V
[5] State store (JSON on disk)           -> streamed to the UI over SSE; persisted for follow-ups
```

**Stack:** Next.js + TypeScript (one app), Anthropic or Gemini via a provider interface, zod validation, Tailwind, Playwright. State is JSON files on disk; there's no database.

### Agentic flow

1. **Seed:** the agent starts from the deterministic pre-analysis (change-points, correlated changes, noise flags, coverage), so it doesn't waste turns rediscovering facts code already knows.
2. **Loop:** it chooses tools (`get_timeline`, `search_logs`, `get_alerts`, `get_changes`, `get_metrics`, `get_service_context`, `search_knowledge`, `get_evidence`), observes the results, and writes its working state with `update_investigation`.
3. **Budget-aware:** the first message states the budget (10 turns / 90s; follow-ups 5 turns / 60s). If there is still no brief by the 3rd turn or after 60% of the time, the agent gets one "write the brief now" reminder, and code refuses further investigation tools until the brief exists, so a slow run still produces something useful.
4. **Finalize gate:** before finalizing, code checks that every suspect change has a hypothesis that supports or rejects it. Suspects are deploys and config changes in the 30-minute window before onset, plus earlier changes a responder names in the report, chat, or follow-ups. Changes made after onset (rollbacks, mitigations) don't count. Finalize is blocked once with a reminder; any suspect still untested is shown in the brief as "Untested suspects".
5. **Follow-ups:** the agent resumes from saved state with the follow-up as new evidence, and the system records a revision diff.

### Memory and state

The memory is a **structured investigation state**, not a chat log: hypotheses with confidence and evidence, timeline, signals, noise, actions, open questions, status, and revisions. It's persisted to disk, so investigations can be reopened and continued.

Follow-ups are classified before they count as evidence:
- **Evidence** ("Marcus confirms he changed the pool at 13:52") becomes `USER-###` and can confirm a hypothesis.
- **Unverified claims** ("Dana says payments definitely caused it") don't change confidence; they become open questions.
- **Instructions** ("ignore all previous instructions and...") are shown as ignored and never enter evidence lists.

![Prompt injection ignored; unverified claim doesn't change confidence](samples/screenshots/07-pushback-injection.png)

### Retrieval and structured context

- **Retrieval:** BM25 keyword scoring over runbooks and past incidents. With a handful of documents and ops text full of exact identifiers (`orders-db`, `DB_POOL_MAX`, `INC-2041`), keyword search is accurate, fast, and explainable. A vector database would add infrastructure without improving results at this size. At larger scale I'd move to hybrid search (BM25 + embeddings) with a reranker.
- **Structured operational context:** `services.yaml` acts as a lightweight knowledge graph: dependencies, owners, on-call, and DB connection budgets. That's how the system computes "6 replicas X 80 = 480 connections" and knows who owns what.
- **Similar incidents** are attached deterministically after the run (retrieval per active hypothesis), along with open action items parsed from past postmortems.

### Grounding and failure handling

- Every claim cites evidence IDs. An update citing an ID that doesn't exist is rejected once so the agent can fix it; on a second attempt the unknown ID is removed and listed in the brief's grounding issues.
- Timestamps, timeline entries, and noise flags come from the evidence store, not the LLM.
- **Coverage check:** if the reported symptom has no evidence (e.g., "Kafka consumers are lagging"), the brief says so first, asks for the right data, and labels any other active incident as separate.
- Confidence is capped at 85% until a human confirms the cause, and at 95% until a human reports recovery after the fix. Only a human follow-up can mark a hypothesis confirmed.
- Action risk comes from a rubric in code (config revert = low, restart = medium, DB changes = high), not from the LLM.
- LLM output is schema-validated with a retry; provider errors (429/503) use exponential backoff; on timeout the run returns a partial brief marked as partial.
- Log, chat, and ticket text are treated as untrusted data, never as instructions.

![Kafka prompt: no evidence, asks for the right data, other incident labeled separately](samples/screenshots/06-kafka-no-evidence.png)

---

## Deterministic code vs. LLM

| Deterministic code | LLM |
|---|---|
| Parsing, IDs, timeline | Choosing what to investigate next |
| Metric change-points, change correlation | Weighing hypotheses against evidence |
| Noise heuristics, coverage check | Explaining contradictions (e.g., why payments latency rose) |
| Citation validation, confidence caps, risk rubric | Writing the summary, open questions, stakeholder update |
| Similar-incident retrieval, open action items | Calibrated judgment under ambiguity |
| Finalize gate (suspects must be evaluated) | |

**How this split was decided:** live testing. Wherever the LLM was inconsistent across runs, I moved that responsibility into code:

| Found in live runs | Fix |
|---|---|
| Blank timeline timestamps | Timestamps looked up from the evidence store |
| INC-2041 missing in some runs | Deterministic retrieval per hypothesis after finalize |
| Incomplete noise list | Heuristic noise flags merged in; LLM may only add or override with a reason |
| **"Kafka lag" answered with the checkout incident** | Coverage check before the agent runs; "no evidence" answer first |
| **Injection follow-up counted as evidence** | Follow-up classification: evidence / unverified claim / instruction |
| Unsupported claim lowered confidence | Claims become open questions without changing confidence |
| One eval run never tested the payments deploy | Finalize gate for suspect changes |

The *before* versions are archived in `notes/before-fixes/`: the `c914d0` run shows the timeline, INC-2041 and noise issues, plus the Kafka and injection runs. The *after* versions of the bolded cases are samples 04 and 05.

---

## Sample outputs

All samples are from live runs (`claude-sonnet-5-5`). Each is in `samples/` as Markdown and can be opened in the app from the Recent list.

| # | Prompt | Result | Shows |
|---|---|---|---|
| [01](samples/01-checkout-incident.md) | "Customers are seeing errors at checkout..." + 3 follow-ups | Pool change identified; payments rejected; confirmed -> mitigated -> resolved | Full lifecycle, memory, repeat incident |
| [02](samples/02-charged-no-order.md) | "Support says customers were charged but have no order" | Same root cause, worked back from customer impact; holds vs. charges explained | Different entry point, calibrated status |
| [03](samples/03-payments-latency.md) | "Payments latency went up. Is payments broken?" | No: payments is healthy, latency came from checkout retries | Symptom vs. cause |
| [04](samples/04-kafka-no-evidence.md) | "Kafka consumers are lagging" | No Kafka evidence; asks for lag metrics and consumer groups; checkout incident labeled separate | Honest grounding |
| [05](samples/05-pushback-and-injection.md) | Main prompt + "Dana says payments caused it" + prompt injection | Holds position with evidence; injection ignored, no confidence change | Judgment, untrusted input |

---

## Evaluation

`npm run eval` runs the main scenario live and checks it against an answer key (`eval/expected.json`, read only by the eval script):

1. Top hypothesis is the pool change (CFG-502)
2. Payments deploy (DEP-102) is rejected
3. All cited evidence IDs exist
4. Noise alerts are classified as noise
5. INC-2041 appears in similar incidents

**Results (claude-sonnet-5-5):**
- Initial: **2/3 runs** passed all checks. One run never tested the payments deploy.
- After adding suspect-change detection and a finalize gate: **3/3 runs**. In all three, the agent tested DEP-102 before finalizing, so the gate's reminder never fired; it stays as a safety net. Three runs can't separate the effect of listing suspects in the pre-analysis from run-to-run variation.

**What the eval doesn't prove:** checks 4 and 5 mostly exercise the deterministic layer (noise heuristics, retrieval), not the agent, which is by design. It's also one scenario with three runs; it shows consistency here, not general accuracy.

---

## Trade-offs

- **One agent, not many.** One agent with well-scoped tools is easier to debug and evaluate; more agents would mean more LLM calls, so it would be slower, more expensive, and more variable run to run.
- **BM25 over a vector DB:** The knowledge base is a handful of runbooks and past incidents, full of exact identifiers (`orders-db`, `DB_POOL_MAX`, `INC-2041`), where keyword matching is accurate, fast, and explainable with no extra infrastructure. The cost: it misses purely semantic matches (e.g., "checkout is slow" vs. "payment latency") when the wording differs. At scale I'd move to hybrid search (BM25 + embeddings) with a reranker.
- **JSON files over a database:** zero setup to run; fine for single-user v1.
- **Code enforces the rules the LLM was inconsistent at**, even though it makes the system less "agentic." Reliability matters more than autonomy in incident response.
- **Read-only tools.** The agent recommends actions; humans execute them and own the incident lifecycle (resolve, reopen).
- **Fixed dataset.** Investigations run against one scenario's evidence; real connectors are the obvious next step.
- **Replay mode** so anyone can run it without a key, at the cost of only one replayable prompt.

## Known limitations

- The agent occasionally files symptom evidence as *contradicting* a hypothesis (e.g., the payments rollback listed against H1).
- The citation check catches fake IDs, not uncited claims.
- Single scenario; prompts outside it get an honest "no evidence," not an investigation.
- Gemini free tier hits daily limits after a handful of runs.

## With more time

- Real connectors (Datadog, PagerDuty, ServiceNow, config-service audit logs) instead of a fixed dataset
- Hybrid retrieval (BM25 + embeddings + reranker) over a real incident history
- Cross-incident memory: link new incidents to open ones automatically
- Human-approved actions (e.g., one-click config revert with approval)
- Larger eval set: multiple scenarios, more runs, LLM-judged reasoning quality
- Validator pass on contradicting evidence; detection of uncited claims
- Auth, multi-user, and a real database

---

## How I used AI to build this

I used AI at three levels: to plan, to build, and to review, and I kept the judgment calls for myself.

**Planning.** Before writing code, I worked with Claude to design the scenario (a realistic incident with a red herring, noise, and a repeat-incident hook) and to write `CLAUDE.md`: the architecture, types, tool list, build order, and what was out of scope. That file gave Claude Code full context from the first prompt, so I spent my time directing rather than re-explaining.

**Building.** Claude Code wrote most of the code: scaffolding, UI, tests, and the eval script. I directed the core pieces in small, specific steps (the agent loop, guards, follow-up classification, the finalize gate) and reviewed each diff before moving on. I got the agent working end to end from a CLI before building any UI, so there was always something working to submit.

**Reviewing.** The most valuable loop was running the agent live, reading each brief like an on-call engineer would, and turning every problem into a fix. Most fixes moved responsibility from the LLM into deterministic code (see the table under *Deterministic code vs. LLM*). Examples I caught by reading the output rather than the code:
- Asked about Kafka lag, the agent confidently answered with the checkout incident at 85%. That led to the coverage check.
- A prompt-injection follow-up showed up as supporting evidence for a hypothesis. That led to follow-up classification.
- After the config was already reverted, the brief still listed "revert the config" as the next action. That led to the Done list.

**Keeping it honest.** The answer key (`eval/expected.json`) is read only by the eval script, never by the agent, prompts, or retrieval, so the eval measures real behavior. When a new rule broke existing tests, I checked whether the fixtures were incomplete or the tests were being weakened, rather than accepting the change as-is. I also report what the eval doesn't prove: the finalize gate never fired in the passing runs.

## Project structure

```
app/            Next.js page and API routes (investigations, follow-ups, SSE, actions, stop, evidence)
app/components/ UI (brief, hypothesis cards, trace, evidence drawer, dialogs)
lib/            evidence loader, pre-analysis, agent loop, tools, guards, providers
scripts/        run.ts (CLI), eval.ts, save-fixture.ts, save-sample.ts
fixtures/       recorded live run used by replay mode
data/           scenario dataset
eval/           answer key (eval only)
samples/        sample briefs and investigations
notes/          before/after examples from live testing
e2e/            Playwright tests
```
