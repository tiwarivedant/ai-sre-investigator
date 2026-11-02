# Investigation brief
_sample-04-kafka-no-evidence · run: **complete** · incident: **insufficient-evidence** · updated 2026-11-02T20:13:05.867Z_

> Kafka consumers are lagging.

## Answer
No evidence about **kafka, consumer** in the available data (searched catalog, alerts, logs, metrics, changes).
- To investigate, provide consumer lag metrics per consumer group, consumer group names, broker logs, and which services produce to or consume the affected topics.

> **Other active incident:** INC-2213 checkout errors: orders-db connection exhaustion (`CFG-502` `ALR-006` `ALR-007` `LOG-040` `CUST-001`); unknown; no Kafka link in the data. Likely cause: inventory-service DB_POOL_MAX 20->80 (CFG-502) exhausted orders-db max_connections (owner: inventory-service / orders-db teams).

## Summary
No evidence exists for the reported symptom (Kafka consumer lag): "kafka", "consumer" and "lag" appear nowhere in the catalog, alerts, logs, metrics or changes. A separate incident, INC-2213, is active: orders-db connection exhaustion after inventory-service DB_POOL_MAX was raised from 20 to 80 (CFG-502) at 13:52. That change coincides with the metric onset at 13:55 (MET-orders_db.active_connections, MET-inventory.db_pool_in_use). It causes checkout errors. It is not a Kafka issue, and I can't link it to the report.

**Overall confidence:** 30%

## Impact
Reported Kafka lag: no evidence of impact in this data. The separate INC-2213 started at 13:55 on the metrics. It shows checkout 5xx rising from 0.32% to a 7.9% peak (MET-checkout.error_rate_pct) and orders-db connections at 99% (MET-orders_db.active_connections). Support saw 87 tickets by 14:30 (CUST-001) and 14 reports of cards charged with no order confirmation (CUST-002).

## Hypotheses

### H1 · ACTIVE · 30%
Kafka consumer lag is a separate problem not visible in this data; no Kafka telemetry exists to evaluate.

- Supporting: `ALR-012`
- Contradicting: none
- Reasoning: Coverage check found zero evidence for kafka, consumer or lag. Cannot be confirmed or refuted here.

### H2 · ACTIVE · 5%
Kafka lag is related to the active checkout/orders-db incident (e.g. consumers blocked on DB connections).

- Supporting: `ALR-006`
- Contradicting: `CUST-004`
- Reasoning: Speculative; no Kafka component appears in the dependencies or logs. orders-service sees 'too many clients' errors, which could indirectly slow any DB-bound consumer, but there is no evidence.

**Not yet explained** (anomalies no hypothesis, signal or noise entry accounts for):
- `MET-payments.p95_latency_ms` payments.p95_latency_ms rose 416.25 -> 640 at 14:00, recovered 14:20
  - possibly related: `ALR-009` alert note: Fires on inbound request latency, which includes time waiting on checkout's retried calls.
  - possibly related: `LOG-046` log: inbound request queue depth 42 (client checkout-service retries)
  - possibly related: `CFG-504` series moved -35.1% in the 15 min after this change (confounded with DEP-103)
  - possibly related: `DEP-103` series moved -35.1% in the 15 min after this change (confounded with CFG-504)

> **Repeat incident.** `INC-2041` had the same failure, and its action items are still open:
> - [ ] Add PgBouncer in front of orders-db
> - [ ] Config-service guardrail on pool sizes

## Similar past incidents
- `INC-2041` Resembles H2 (active). Orders failing, orders-db connection exhaustion: reporting-service raised its DB pool from 15 to 100 to speed up a quarterly report. _(matched by retrieval)_
  - Lesson: 30 minutes lost investigating the most recent deploy rather than recent config changes.

## Contributing factors
- Safeguard still missing: "Add PgBouncer in front of orders-db" was an action item from INC-2041 and is still open. · evidence: `INC-2041` _(derived from data)_
- Safeguard still missing: "Config-service guardrail on pool sizes" was an action item from INC-2041 and is still open. · evidence: `INC-2041` _(derived from data)_

## Timeline (UTC)
- **13:40** `DEP-102` Deploy payments-service v2.14.0: Add 3DS2 challenge flow for EU cards; bump HTTP client library to 5.2
- **13:52** `CFG-502` Config inventory-service (config-service, by mlee): DB_POOL_MAX: 20 -> 80
- **13:55** `MET-checkout.error_rate_pct` Rose 0.32 -> 1.1 (peak 7.9)
- **13:55** `MET-inventory.db_pool_in_use` Rose 78 -> 290 (peak 323)
- **13:55** `MET-orders_db.active_connections` Rose 244.5 -> 331 (peak 397)
- **14:00** `ALR-006` [critical] orders-db active connections above 95% of max (393 / 400)
- **14:03** `CUST-001` Spike in "Something went wrong" at Place Order. 87 tickets by 14:30 (normal: ~5/hour).
- **14:06** `ALR-012` [critical] INC-2213 opened: Checkout errors and slowness reported by customers

## Key signals
- `ALR-012` [critical] INC-2213 opened: Checkout errors and slowness reported by customers

## Noise (ruled out)
- `ALR-001` _heuristic: outside blast radius, preceded onset_
- `ALR-002` _heuristic: not in catalog, preceded onset_
- `ALR-003` _heuristic: resolved quickly, repeated flap, outside blast radius_
- `ALR-011` _heuristic: info severity_
- `ALR-013` _heuristic: resolved quickly, repeated flap, outside blast radius_

## Next actions
1. **[low risk]** Collect consumer lag metrics per consumer group, consumer group names, broker logs, and which services produce to or consume the affected topics, from the owners of kafka/consumer, and add it as a follow-up · evidence: none · _rubric: investigate = low_
2. **[low risk]** Ask the reporter for the consumer group, topic and service, and the lag graphs (owner: incident responder) · evidence: `ALR-012` · _rubric: investigate = low_
3. **[low risk]** Route the report to the Kafka/streaming platform owners (owner: streaming platform on-call) · evidence: `ALR-012` · _rubric: investigate = low_
4. **[low risk]** Check their lag dashboards, which are outside this dataset (owner: streaming platform on-call) · evidence: `ALR-012` · _rubric: investigate = low_

## Prevent recurrence (post-incident)
1. **[P1]** Close INC-2041's open action item: Add PgBouncer in front of orders-db · evidence: `INC-2041`
2. **[P1]** Close INC-2041's open action item: Config-service guardrail on pool sizes · evidence: `INC-2041`

## Open questions
- Which Kafka cluster, consumer group and service is lagging? Reporter to say.
- Is Kafka telemetry (lag metrics, broker logs) available in another system? Platform/streaming team to say.
- Does the lagging consumer write to orders-db? If so it may be affected by connection exhaustion. Its owner to say.

## Stakeholder update
We found no data about Kafka consumer lag in our monitoring, so we can't confirm that report. Separately, an active incident is causing checkout errors and slowness, and its likely cause is a database connection limit being hit after a recent settings change. We are asking the reporter for details and routing the lag report to the streaming team. Next update in 30 minutes.
