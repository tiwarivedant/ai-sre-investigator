# Runbook: checkout-service elevated 5xx

**Owner:** checkout team · **Last reviewed:** 2026-08-14

## Symptoms
- `checkout-service 5xx rate above 2%` alert
- Customers report "Something went wrong" on Place Order

## Triage
1. Check which downstream is failing. checkout logs include the failing dependency in the error message (`orders-service returned 503`, `inventory reserve timed out`, `payments authorize failed`).
2. Check recent deploys **and config changes** for checkout, inventory, payments, and orders. Config changes are in the config-service audit log, not the deploy dashboard.
3. If a single downstream dominates the errors, page that team.

## Common causes
| Cause | Signal | Action |
|---|---|---|
| Bad checkout deploy | Errors start at deploy time, all dependencies healthy | Roll back checkout |
| Payments processor outage | `payments authorize failed` + processor status page red | Enable payments degraded mode |
| orders-db pressure | orders-service 503s, connection timeouts | See `postgres-connection-exhaustion.md` |
| Retry storm | Downstream request rate far above checkout traffic | Disable retries via `payments_retry_on_timeout` flag |

## Don'ts
- Don't roll back services that aren't in the error path. It costs time and adds noise to the timeline.
