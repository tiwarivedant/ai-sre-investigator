# Investigation brief
_sample-03-payments-latency · run: **complete** · incident: **investigating** · updated 2026-11-02T20:03:31.232Z_

> Payments team says their latency went up around 14:00. Is payments broken?”

## Summary
Payments is not the cause. CFG-502 (inventory DB_POOL_MAX 20->80 at 13:52) over-committed orders-db (610 potential vs 400 max); inventory holds ~320 connections (LOG-076, LOG-121), starving orders-service ("too many clients"), causing checkout errors. Payments latency is a secondary effect of checkout retries (LOG-046); the rollback DEP-103 was a red herring and the 5xx alert persists after it (ALR-014).

**Overall confidence:** 85%

## Impact
Onset 13:55. Checkout errors up to 7.9%, p99 5s, orders errors 10% (MET-checkout.error_rate_pct, MET-orders.error_rate_pct). CUST-001: 87 tickets by 14:30; CUST-002: 14 charged without confirmation. Search/browse unaffected (CUST-004).

## Hypotheses

### H1 · ACTIVE · 85%
CFG-502 raised inventory pool to 80 x6 replicas, exhausting orders-db connections; orders-service can't get connections, checkout fails.

- Supporting: `CFG-502` `LOG-076` `LOG-121` `LOG-040` `LOG-033` `MET-inventory.db_pool_in_use` `MET-orders_db.active_connections`
- Contradicting: none
- Reasoning: Onset 13:55 right after config; inventory holds 318-320 of 397 connections; orders pool starved; errors persist after payments rollback. Payments latency from checkout retries into it, eased when CFG-504 disabled retries.

### H2 · REJECTED · 5%
Payments v2.14.0 caused the incident

- Supporting: `DEP-102`
- Contradicting: `DEP-103` `ALR-014` `LOG-046`
- Reasoning: Payments error rate and processor latency unchanged; checkout errors continued after rollback.

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
- **13:55** `MET-checkout.error_rate_pct` Rose 0.32 -> 1.1 (peak 7.9)
- **13:55** `MET-inventory.db_pool_in_use` Rose 78 -> 290 (peak 323)
- **13:55** `MET-orders_db.active_connections` Rose 244.5 -> 331 (peak 397)
- **13:55** `MET-orders.error_rate_pct` Rose 0.1 -> 2.4 (peak 10.3)
- **13:57** `LOG-033` ERROR orders-service: FATAL: remaining connection slots are reserved for non-replication superuser connections
- **14:01** `LOG-040` ERROR orders-service: FATAL: sorry, too many clients already
- **14:03** `CUST-001` Spike in "Something went wrong" at Place Order. 87 tickets by 14:30 (normal: ~5/hour).
- **14:03** `LOG-046` WARN payments-service: inbound request queue depth 42 (client checkout-service retries)
- **14:11** `LOG-076` LOG orders-db: connections: inventory_svc=318 orders_svc=64 reporting_svc=12 superuser=3 total=397/400
- **14:16** `CFG-504` Config checkout-service (feature-flag-service, by pshah): flag payments_retry_on_timeout: true -> false
- **14:18** `DEP-103` Rollback payments-service v2.13.4: Rollback v2.14.0 during INC-2213 investigation
- **14:22** `ALR-014` [critical] checkout-service 5xx rate above 2% (still firing after payments rollback) (7.4%)
- **14:24** `LOG-121` LOG orders-db: connections: inventory_svc=320 orders_svc=63 reporting_svc=11 superuser=3 total=397/400

## Key signals
- `CFG-502` Config inventory-service (config-service, by mlee): DB_POOL_MAX: 20 -> 80
- `LOG-076` LOG orders-db: connections: inventory_svc=318 orders_svc=64 reporting_svc=12 superuser=3 total=397/400
- `LOG-121` LOG orders-db: connections: inventory_svc=320 orders_svc=63 reporting_svc=11 superuser=3 total=397/400
- `LOG-040` ERROR orders-service: FATAL: sorry, too many clients already
- `LOG-033` ERROR orders-service: FATAL: remaining connection slots are reserved for non-replication superuser connections
- `MET-inventory.db_pool_in_use` Rose 78 -> 290 (peak 323)

## Noise (ruled out)
- `ALR-001` _heuristic: outside blast radius, preceded onset_
- `ALR-002` _heuristic: not in catalog, preceded onset_
- `ALR-003` _heuristic: resolved quickly, repeated flap, outside blast radius_
- `ALR-011` _heuristic: info severity_
- `ALR-013` _heuristic: resolved quickly, repeated flap, outside blast radius_

## Next actions
1. **[low risk]** Revert inventory-service DB_POOL_MAX to 20 (owner: inventory-service on-call) · evidence: `CFG-502` `LOG-076` · _rubric: config revert = low_
2. **[low risk]** Tell payments team their latency was a downstream effect of checkout retries, not a payments fault (owner: incident commander) · evidence: `LOG-046` `CFG-504` · _rubric: communicate = low_
3. **[low risk]** Reconcile the 14 'charged but no confirmation' orders and holds (owner: payments / orders on-call) · evidence: `CUST-002` · _rubric: investigate = low_

## Prevent recurrence (post-incident)
1. **[P1]** Add PgBouncer and a connection-budget guardrail on pool changes (INC-2041 item open) (owner: platform/DBA) · evidence: `INC-2041` `CFG-502`

## Open questions
- Did the inventory owner intend CFG-502, and why? (inventory on-call)
- Were any customers double-charged? (payments team)

## Stakeholder update
Customers are seeing failures when placing orders since about 14:00. Payments is not broken; its slowness was a side effect. The likely cause is a configuration change that let the inventory service take most of the shared database's connections, leaving the orders service starved. We are reverting that setting and will check the 14 orders where a card was charged without confirmation. Next update in 30 minutes.
