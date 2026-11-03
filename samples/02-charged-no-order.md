# Investigation brief
_sample-02-charged-no-order · run: **complete** · incident: **investigating** · updated 2026-11-02T20:01:50.478Z_

> Support says customers were charged but have no order.

## Summary
CFG-502 (inventory DB_POOL_MAX 20->80 at 13:52) overcommitted orders-db (budget 610 vs max 400), exhausting connections (397/400, LOG-076) so orders-service could not create orders after payment authorization. Payments confirms the 14 affected customers have duplicate holds, not completed captures, which auto-release in 3-5 days (USER-001). The cause is still the likely one and not confirmed by the change owner. Recovery not yet verified.

**Overall confidence:** 85%

## Impact
Onset 13:55. Checkout 5xx up to 7.9%, orders error up to 10.3%; 87 tickets by 14:30 (CUST-001). 14 customers report being charged with no order (CUST-002); payments confirms these are duplicate holds that auto-release in 3-5 days (USER-001). Customers may see held funds for days. All regions (CUST-005).

## Hypotheses

### H1 · ACTIVE · 85%
CFG-502 raised inventory pool to 80 x6 replicas, exhausting orders-db connections; orders-service failed to create orders after payment auth, leaving holds

- Supporting: `CFG-502` `LOG-076` `LOG-121` `LOG-033` `LOG-040` `MET-orders_db.active_connections` `MET-inventory.db_pool_in_use` `USER-001`
- Contradicting: `MET-payments.p95_latency_ms`
- Reasoning: Timing and connection snapshots fit; USER-001 shows the customer harm is holds from auth without order, consistent with order creation failing. Not human-confirmed.

### H2 · REJECTED · 5%
Payments v2.14.0 caused the issue

- Supporting: `DEP-102`
- Contradicting: `DEP-103` `ALR-014`
- Reasoning: Rollback did not clear errors.

> **Repeat incident.** `INC-2041` had the same failure, and its action items are still open:
> - [ ] Add PgBouncer in front of orders-db
> - [ ] Config-service guardrail on pool sizes

## Similar past incidents
- `INC-2041` Resembles H1 (active). Orders failing, orders-db connection exhaustion: reporting-service raised its DB pool from 15 to 100 to speed up a quarterly report. _(matched by retrieval)_
  - Lesson: 30 minutes lost investigating the most recent deploy rather than recent config changes.
- `INC-1987` Resembles H2 (rejected). Checkout 500s after payments deploy: payments-service v2.9.0 shipped a serialization bug for a new card-network field. _(matched by retrieval)_
  - Lesson: payments-service's own error rate jumped from 0.2% to 12% within 2 minutes of the 100% rollout.

## Contributing factors
- Safeguard still missing: "Add PgBouncer in front of orders-db" was an action item from INC-2041 and is still open. · evidence: `INC-2041` _(derived from data)_
- Safeguard still missing: "Config-service guardrail on pool sizes" was an action item from INC-2041 and is still open. · evidence: `INC-2041` _(derived from data)_
- CFG-502 was a hot-reloaded config change (inventory-service) that does not appear on the deploy dashboard, so a deploy-focused search misses it; INC-2041 hit the same visibility gap. · evidence: `CFG-502` `INC-2041` _(derived from data)_

## Timeline (UTC)
- **13:40** `DEP-102` Deploy payments-service v2.14.0: Add 3DS2 challenge flow for EU cards; bump HTTP client library to 5.2 _(ruled out)_
- **13:52** `CFG-502` Config inventory-service (config-service, by mlee): DB_POOL_MAX: 20 -> 80
- **13:55** `MET-inventory.db_pool_in_use` Rose 78 -> 290 (peak 323)
- **13:55** `MET-orders_db.active_connections` Rose 244.5 -> 331 (peak 397)
- **13:57** `LOG-033` ERROR orders-service: FATAL: remaining connection slots are reserved for non-replication superuser connections
- **14:00** `MET-payments.p95_latency_ms` Rose 416.25 -> 640 (peak 650), recovered 14:20
- **14:01** `LOG-040` ERROR orders-service: FATAL: sorry, too many clients already
- **14:03** `CUST-001` Spike in "Something went wrong" at Place Order. 87 tickets by 14:30 (normal: ~5/hour).
- **14:11** `LOG-076` LOG orders-db: connections: inventory_svc=318 orders_svc=64 reporting_svc=12 superuser=3 total=397/400
- **14:18** `DEP-103` Rollback payments-service v2.13.4: Rollback v2.14.0 during INC-2213 investigation
- **14:22** `ALR-014` [critical] checkout-service 5xx rate above 2% (still firing after payments rollback) (7.4%)
- **14:24** `LOG-121` LOG orders-db: connections: inventory_svc=320 orders_svc=63 reporting_svc=11 superuser=3 total=397/400
- **follow-up** `USER-001` Follow-up: Payments confirms 14 duplicate holds, auto-release in 3–5 days.

## Key signals
- `CFG-502` Config inventory-service (config-service, by mlee): DB_POOL_MAX: 20 -> 80
- `LOG-076` LOG orders-db: connections: inventory_svc=318 orders_svc=64 reporting_svc=12 superuser=3 total=397/400
- `LOG-121` LOG orders-db: connections: inventory_svc=320 orders_svc=63 reporting_svc=11 superuser=3 total=397/400
- `LOG-033` ERROR orders-service: FATAL: remaining connection slots are reserved for non-replication superuser connections
- `LOG-040` ERROR orders-service: FATAL: sorry, too many clients already
- `MET-orders_db.active_connections` Rose 244.5 -> 331 (peak 397)

## Noise (ruled out)
- `ALR-001` _heuristic: outside blast radius, preceded onset_
- `ALR-002` _heuristic: not in catalog, preceded onset_
- `ALR-003` _heuristic: resolved quickly, repeated flap, outside blast radius_
- `ALR-011` _heuristic: info severity_
- `ALR-013` _heuristic: resolved quickly, repeated flap, outside blast radius_

## Next actions
1. **[low risk]** Revert inventory-service DB_POOL_MAX to 20 (owner: inventory-service on-call) · evidence: `CFG-502` `LOG-076` · _rubric: config revert = low_
2. **[low risk]** Give support guidance that the 14 holds auto-release in 3-5 days (owner: payments on-call / support) · evidence: `USER-001` `CUST-002` · _rubric: communicate = low_
3. **[low risk]** Ask payments whether to release them early (owner: payments on-call / support) · evidence: `USER-001` `CUST-002` · _rubric: investigate = low_

## After recovery is verified
1. **[low risk]** Re-enable payments_retry_on_timeout only after recovery verified (owner: checkout on-call) · evidence: `CFG-504` · _rubric: flag change = low_

## Prevent recurrence (post-incident)
1. **[P1]** Deploy PgBouncer in front of orders-db (owner: platform/DBA) · evidence: `INC-2041`
2. **[P1]** Add guardrail on pool-size config changes (owner: platform) · evidence: `INC-2041` `CFG-502`

## Open questions
- Did the inventory owner intend CFG-502, and why?
- Are there other affected customers beyond the 14 reported? (payments/support)
- Can the holds be released early? (payments)

## Stakeholder update
Some customers saw checkout errors, and 14 reported being charged without an order. Payments confirms these are temporary holds, not completed charges, and they release automatically in 3-5 days. The likely cause is a settings change that let one service use too many database connections, blocking order creation. We are reverting that setting. Next update in 30 minutes.

## Revisions
- 2026-11-02T20:01:50.480Z (follow-up USER-001: Payments confirms 14 duplicate holds, auto-release in 3–5 days.): H1 new supporting evidence: USER-001; H2 confidence 8% -> 5%; open questions: 1 resolved, 2 new; 4 new next actions
