# Runbook: Postgres connection exhaustion (orders-db)

**Owner:** platform/DBRE · **Last reviewed:** 2026-06-30 (after INC-2041)

## Symptoms
- `orders-db active connections above 95% of max`
- App errors: `remaining connection slots are reserved`, `too many clients already`, Hikari `Connection is not available`
- Latency spikes in every service that shares orders-db, even if only one service changed

## Diagnose
1. Find who holds the connections:
   ```sql
   SELECT usename, count(*) FROM pg_stat_activity GROUP BY usename ORDER BY 2 DESC;
   ```
2. Compare against expected budget (max_connections = 400):
   | Service | Replicas | Pool max | Budget |
   |---|---|---|---|
   | inventory-service | 6 | 20 | 120 |
   | orders-service | 4 | 25 | 100 |
   | reporting-service | 2 | 15 | 30 |
   | **Total** | | | **250** |
3. Check the config-service audit log for recent `DB_POOL_MAX` changes. These hot-reload without a deploy and are easy to miss.

## Mitigate
1. Revert the offending pool size in config-service (hot-reloads in ~30s).
2. If unknown, restart the service holding the most connections (pools reset).
3. Do **not** raise `max_connections` on the DB without DBRE approval; it needs a restart and more memory.

## Long-term
- Put PgBouncer in front of orders-db (open action item from INC-2041).
- Add a guardrail in config-service: reject pool changes where replicas × pool exceeds the service's budget.
