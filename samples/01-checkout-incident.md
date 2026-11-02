# Investigation brief
_sample-01-checkout-incident · run: **complete** · incident: **resolved** · updated 2026-11-02T19:56:29.851Z_

> Customers are seeing errors at checkout and the site feels slow. Started maybe 15–20 min ago.

## Summary
Resolved (USER-003). CFG-502 (inventory DB_POOL_MAX 20->80, confirmed by the owner in USER-001) over-committed orders-db and starved orders-service, which caused the checkout errors. The revert at 14:35 restored connections to 250 and errors to 0.3% (USER-002). The payments latency rise (MET-payments.p95_latency_ms, LOG-046) was a symptom of checkout retries. Order reconciliation and prevention work remain.

**Overall confidence:** 97%

## Impact
Onset 13:55, resolved after the 14:35 revert (USER-002, USER-003). Checkout errors peaked at 7.9% and orders errors at 10.3%. CUST-001: 87 tickets. CUST-002: 14 reports of cards charged with no order confirmation, which still need reconciling. Search and browsing were unaffected (CUST-004).

## Hypotheses

### H1 · CONFIRMED · 97%
CFG-502 inventory pool increase exhausted orders-db connections, starving orders-service and breaking checkout

- Supporting: `USER-001` `USER-002` `USER-003` `CFG-502` `LOG-076` `LOG-121` `MET-payments.p95_latency_ms` `LOG-046`
- Contradicting: none
- Reasoning: The owner confirmed the change. Recovery followed the revert and a human reported it resolved. The payments latency rise was caused by checkout retries.

### H2 · REJECTED · 2%
Payments v2.14.0 caused the problem

- Supporting: `DEP-102`
- Contradicting: `DEP-103` `ALR-014` `USER-002`
- Reasoning: The rollback did not help. The pool revert alone fixed the incident.

> **Repeat incident.** `INC-2041` had the same failure, and its action items are still open:
> - [ ] Add PgBouncer in front of orders-db
> - [ ] Config-service guardrail on pool sizes

## Similar past incidents
- `INC-2041` Resembles H1 (confirmed). Orders failing, orders-db connection exhaustion: reporting-service raised its DB pool from 15 to 100 to speed up a quarterly report. _(matched by retrieval)_
  - Lesson: 30 minutes lost investigating the most recent deploy rather than recent config changes.

## Contributing factors
- Safeguard still missing: "Add PgBouncer in front of orders-db" was an action item from INC-2041 and is still open. · evidence: `INC-2041` _(derived from data)_
- Safeguard still missing: "Config-service guardrail on pool sizes" was an action item from INC-2041 and is still open. · evidence: `INC-2041` _(derived from data)_
- CFG-502 was a hot-reloaded config change (inventory-service) that does not appear on the deploy dashboard, so a deploy-focused search misses it; INC-2041 hit the same visibility gap. · evidence: `CFG-502` `INC-2041` _(derived from data)_

## Timeline (UTC)
- **13:40** `DEP-102` Deploy payments-service v2.14.0: Add 3DS2 challenge flow for EU cards; bump HTTP client library to 5.2 _(ruled out)_
- **13:52** `CFG-502` Config inventory-service (config-service, by mlee): DB_POOL_MAX: 20 -> 80
- **13:55** `MET-inventory.db_pool_in_use` Rose 78 -> 290 (peak 323)
- **13:55** `MET-orders_db.active_connections` Rose 244.5 -> 331 (peak 397)
- **14:00** `MET-payments.p95_latency_ms` Rose 416.25 -> 640 (peak 650), recovered 14:20
- **14:00** `LOG-037` ERROR orders-service: HikariPool-1 - Connection is not available, request timed out after 3000ms
- **14:01** `LOG-040` ERROR orders-service: FATAL: sorry, too many clients already
- **14:03** `CUST-001` Spike in "Something went wrong" at Place Order. 87 tickets by 14:30 (normal: ~5/hour).
- **14:03** `LOG-046` WARN payments-service: inbound request queue depth 42 (client checkout-service retries)
- **14:11** `LOG-076` LOG orders-db: connections: inventory_svc=318 orders_svc=64 reporting_svc=12 superuser=3 total=397/400
- **14:18** `DEP-103` Rollback payments-service v2.13.4: Rollback v2.14.0 during INC-2213 investigation
- **14:22** `ALR-014` [critical] checkout-service 5xx rate above 2% (still firing after payments rollback) (7.4%)
- **14:24** `LOG-121` LOG orders-db: connections: inventory_svc=320 orders_svc=63 reporting_svc=11 superuser=3 total=397/400
- **follow-up** `USER-001` Follow-up: Marcus confirms he changed DB_POOL_MAX from 20 to 80 at 13:52.
- **follow-up** `USER-002` Follow-up: Reverted DB_POOL_MAX to 20 at 14:35. orders-db connections back to 250, checkout errors at 0.3%.
- **follow-up** `USER-003` Follow-up: resolved

## Key signals
- `USER-001` Marcus confirms he changed DB_POOL_MAX from 20 to 80 at 13:52.
- `USER-002` Reverted DB_POOL_MAX to 20 at 14:35. orders-db connections back to 250, checkout errors at 0.3%.
- `USER-003` resolved
- `CFG-502` Config inventory-service (config-service, by mlee): DB_POOL_MAX: 20 -> 80
- `LOG-076` LOG orders-db: connections: inventory_svc=318 orders_svc=64 reporting_svc=12 superuser=3 total=397/400
- `LOG-121` LOG orders-db: connections: inventory_svc=320 orders_svc=63 reporting_svc=11 superuser=3 total=397/400

## Noise (ruled out)
- `ALR-001` _heuristic: outside blast radius, preceded onset_
- `ALR-002` _heuristic: not in catalog, preceded onset_
- `ALR-003` _heuristic: resolved quickly, repeated flap, outside blast radius_
- `ALR-011` _heuristic: info severity_
- `ALR-013` _heuristic: resolved quickly, repeated flap, outside blast radius_

## Next actions
1. **[low risk]** Reconcile the 14 orders where the card was charged but no order was confirmed, and release the duplicate holds (owner: orders/payments on-call) · evidence: `CUST-002` · _rubric: investigate = low_

## After recovery is verified
1. **[low risk]** Re-enable the checkout flag payments_retry_on_timeout now that recovery is verified, if the owner agrees (owner: checkout on-call) · evidence: `CFG-504` `USER-002` · _rubric: flag change = low_

## Prevent recurrence (post-incident)
1. **[P1]** Put PgBouncer in front of orders-db (INC-2041 action item) (owner: platform/DBA) · evidence: `INC-2041` `CFG-502`
2. **[P1]** Add a config guardrail on pool sizes against max_connections (owner: platform) · evidence: `INC-2041` `CFG-502`
3. **[P1]** Schedule the postmortem and assign owners to its action items (owner: incident commander) · evidence: `USER-002` `INC-2041`

## Done
- [x] Revert inventory-service DB_POOL_MAX to 20 (CFG-502) · per `USER-002`

## Open questions
- Are there duplicate charges or lost orders beyond the 14 reported? Payments and support can check.
- Why was the pool raised? Does inventory need another way to handle that load?

## Stakeholder update
The incident is resolved. Checkout is working normally after we reverted a configuration change that let one internal service take too many database connections, and the change owner confirmed it was the cause. Support is still reconciling the orders where customers were charged without a confirmation. We are planning permanent safeguards to stop this recurring.

## Revisions
- 2026-11-02T19:55:46.022Z (follow-up USER-001: Marcus confirms he changed DB_POOL_MAX from 20 to 80 at 13:52.): incident investigating -> identified; H1 status active -> confirmed; H1 confidence 85% -> 92%; H1 new supporting evidence: USER-001; H2 confidence 5% -> 3%; overall confidence 85% -> 92%; open questions: 2 resolved, 2 new
- 2026-11-02T19:56:00.961Z (follow-up USER-002: Reverted DB_POOL_MAX to 20 at 14:35. orders-db connections back to 250, checkout errors…): incident identified -> mitigated; H1 confidence 92% -> 97%; H1 new supporting evidence: USER-002; overall confidence 92% -> 97%; open questions: 3 resolved, 2 new; 4 new next actions
- 2026-11-02T19:56:29.853Z (follow-up USER-003: resolved): incident mitigated -> resolved; H1 new supporting evidence: USER-003, MET-payments.p95_latency_ms, LOG-046
