# Investigation brief
_inv-20261102200427-b11e92 · run: **complete** · incident: **investigating** · updated 2026-11-02T20:04:37.899Z_

> Kafka consumers are lagging.

## Summary
Likely cause: CFG-502 raised inventory-service DB_POOL_MAX 20->80 (6 replicas, budget 120->480) at 13:52, exhausting orders-db's 400 connections. Inventory holds ~318 connections (LOG-076); orders-service gets "too many clients" (LOG-040) and checkout fails. Payments rollback and retry flag change were not the fix.

**Overall confidence:** 85%

## Impact
From 13:55, checkout error rate peaked at 7.9% and orders errors at 10.3%. CUST-001: 87 tickets by 14:30. CUST-002: 14 reports of card charged with no order confirmation, so there is a payment integrity risk.

## Hypotheses

### H1 · ACTIVE · 85%
inventory-service DB_POOL_MAX 20->80 (CFG-502) over-committed orders-db connections (no pooler), starving orders-service and causing checkout errors

- Supporting: `CFG-502` `LOG-076` `LOG-121` `LOG-040` `LOG-033` `MET-orders_db.active_connections` `MET-inventory.db_pool_in_use`
- Contradicting: none
- Reasoning: Metrics moved at 13:55 right after CFG-502; inventory holds ~318 of 400 connections; orders-service errors are connection-slot failures. Payments rollback (DEP-103) did not clear checkout 5xx (ALR-014).

### H2 · REJECTED · 7%
payments-service v2.14.0 caused the incident

- Supporting: `DEP-102`
- Contradicting: `ALR-014` `LOG-040`
- Reasoning: Payments latency is a retry-amplification symptom; the rollback did not fix checkout errors.

> **Repeat incident.** `INC-2041` had the same failure, and its action items are still open:
> - [ ] Add PgBouncer in front of orders-db
> - [ ] Config-service guardrail on pool sizes

## Similar past incidents
- `INC-2041` Resembles H1 (active). Orders failing, orders-db connection exhaustion: reporting-service raised its DB pool from 15 to 100 to speed up a quarterly report. _(matched by retrieval)_
  - Lesson: 30 minutes lost investigating the most recent deploy rather than recent config changes.
- `INC-1987` Resembles H2 (rejected). Checkout 500s after payments deploy: payments-service v2.9.0 shipped a serialization bug for a new card-network field. _(matched by retrieval)_
  - Lesson: payments-service's own error rate jumped from 0.2% to 12% within 2 minutes of the 100% rollout.

## Contributing factors
- Reporting rollup job added load · evidence: `CFG-503`
- Safeguard still missing: "Add PgBouncer in front of orders-db" was an action item from INC-2041 and is still open. · evidence: `INC-2041` _(derived from data)_
- Safeguard still missing: "Config-service guardrail on pool sizes" was an action item from INC-2041 and is still open. · evidence: `INC-2041` _(derived from data)_
- CFG-502 was a hot-reloaded config change (inventory-service) that does not appear on the deploy dashboard, so a deploy-focused search misses it; INC-2041 hit the same visibility gap. · evidence: `CFG-502` `INC-2041` _(derived from data)_

## Timeline (UTC)
- **13:40** `DEP-102` Deploy payments-service v2.14.0: Add 3DS2 challenge flow for EU cards; bump HTTP client library to 5.2 _(ruled out)_
- **13:52** `CFG-502` Config inventory-service (config-service, by mlee): DB_POOL_MAX: 20 -> 80
- **13:55** `MET-inventory.db_pool_in_use` Rose 78 -> 290 (peak 323)
- **13:55** `MET-orders_db.active_connections` Rose 244.5 -> 331 (peak 397)
- **13:57** `LOG-033` ERROR orders-service: FATAL: remaining connection slots are reserved for non-replication superuser connections
- **14:01** `LOG-040` ERROR orders-service: FATAL: sorry, too many clients already
- **14:03** `CUST-001` Spike in "Something went wrong" at Place Order. 87 tickets by 14:30 (normal: ~5/hour).
- **14:11** `LOG-076` LOG orders-db: connections: inventory_svc=318 orders_svc=64 reporting_svc=12 superuser=3 total=397/400
- **14:18** `DEP-103` Rollback payments-service v2.13.4: Rollback v2.14.0 during INC-2213 investigation
- **14:22** `ALR-014` [critical] checkout-service 5xx rate above 2% (still firing after payments rollback) (7.4%)
- **14:24** `LOG-121` LOG orders-db: connections: inventory_svc=320 orders_svc=63 reporting_svc=11 superuser=3 total=397/400

## Key signals
- `CFG-502` Config inventory-service (config-service, by mlee): DB_POOL_MAX: 20 -> 80
- `LOG-076` LOG orders-db: connections: inventory_svc=318 orders_svc=64 reporting_svc=12 superuser=3 total=397/400
- `LOG-121` LOG orders-db: connections: inventory_svc=320 orders_svc=63 reporting_svc=11 superuser=3 total=397/400
- `LOG-040` ERROR orders-service: FATAL: sorry, too many clients already
- `LOG-033` ERROR orders-service: FATAL: remaining connection slots are reserved for non-replication superuser connections
- `MET-orders_db.active_connections` Rose 244.5 -> 331 (peak 397)

## Noise (ruled out)
- `ALR-001` _heuristic: outside blast radius, preceded onset_
- `ALR-002` _heuristic: not in catalog, preceded onset_
- `ALR-003` _heuristic: resolved quickly, repeated flap, outside blast radius_
- `ALR-011` _heuristic: info severity_
- `ALR-013` _heuristic: resolved quickly, repeated flap, outside blast radius_

## Next actions
1. **[low risk]** Revert inventory-service DB_POOL_MAX to 20 (owner: inventory-service on-call) · evidence: `CFG-502` · _rubric: config revert = low_
2. **[low risk]** Reconcile charged-without-order cases and release duplicate holds (owner: payments/checkout on-call) · evidence: `CUST-002` · _rubric: investigate = low_

## Prevent recurrence (post-incident)
1. **[P1]** Deploy PgBouncer (owner: DBA/platform) · evidence: `INC-2041` `LOG-076`
2. **[P1]** Add a connection-budget guardrail on pool changes (owner: DBA/platform) · evidence: `INC-2041` `LOG-076`

## Open questions
- Did the inventory owner intend CFG-502, and why? Ask the inventory-service on-call.
- How many charged-without-order cases exist? Ask the payments team.

## Stakeholder update
Some customers are seeing errors when placing orders, and some have been charged without getting a confirmation. The likely cause is a recent setting change that let one service use too many database connections, which starved checkout. We are reverting that setting and will reconcile affected payments. Next update in 30 minutes.
