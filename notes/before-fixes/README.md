# Before fixes: live run `inv-20261102191424-c914d0`

A live run on `anthropic/claude-sonnet-5-5` (2026-11-02, INC-2213 sample incident, one follow-up: "Marcus confirms he changed the pool"), kept as it was before the fixes that followed it.

- `inv-20261102191424-c914d0.json`: the saved investigation, copied unchanged from `.investigations/` (state, trace, revisions, provider history, USER evidence).
- `inv-20261102191424-c914d0-brief.md`: the brief exported from that stored state as-is, not re-derived, so it shows the defects below.

## Issues it shows

1. **Blank timeline timestamps.** The model wrote bare times (`"13:52"`) into the timeline instead of timestamps, so the time column renders blank (`- ****` in the brief). *Fix:* timeline times now come from the evidence store by ID (metric entries use their change-point time); the LLM only supplies the ID and a note.
2. **INC-2041 missing from similar incidents.** Only INC-1987 was matched (to the rejected payments hypothesis). For H1, INC-2041 scored 8.4 but INC-1987 scored 6.1, and the "best match must be 2x the runner-up" rule dropped it, so the repeat-incident callout (INC-2041's open PgBouncer and pool-guardrail items) never appeared. *Fix:* every live hypothesis gets its top match above the score floor; the 2x rule applies only to rejected hypotheses; retrieval and repeat detection rerun at finalize.
3. **Incomplete noise list.** Noise had ALR-011, ALR-001, ALR-003; ALR-002 (TLS cert expiring in 21 days) and ALR-013 (repeat search-service flap) were flagged by the heuristics but missing. *Fix:* code-flagged noise is always merged in; the agent can only add items, re-word them, or keep one as signal with a reason (`notNoise`).
4. **Stale summary after follow-up.** The follow-up confirmed H1 (status `confirmed`), but the summary still ends "High confidence, not human-confirmed." *Fix:* a follow-up cannot finalize until summary and impact are rewritten, and a code check flags text that contradicts hypothesis status.
5. **Mixed-risk compound action.** "Revert inventory-service DB_POOL_MAX to 20 and roll the pods, then watch orders-db connections" got a single **low** risk, though rolling pods is a medium-risk restart. *Fix:* compound actions are split per operation, each with its own risk ("roll the pods" now counts as a restart).

Also visible: the Impact section cites no customer notes (87 support tickets, 14 "charged but no order" reports), and the PgBouncer/guardrail prevention item is rated "high risk" instead of being prioritised. Both were fixed in the same pass.

## Other archived runs

- `pushback-injection-before.{json,md}` (`inv-20261102201439-c7df21`, checkout incident with two adversarial follow-ups: an unsupported "Dana says payments caused it" and a prompt injection). Issues: the injection follow-up (USER-002) was counted as hypothesis evidence (supporting H2, contradicting H1); the summary led with the injection; Dana's unsupported claim (USER-001) lowered H1's confidence 85% -> 80%; "Ask Dana what evidence links v2.14.0..." was mislabeled medium risk (the word "rollback" triggered the code-rollback escalation on an investigate step); the Done item "Roll back payments v2.14.0" cited the follow-up (USER-001) alongside DEP-103, when the rollback is evidenced by DEP-103 alone.
