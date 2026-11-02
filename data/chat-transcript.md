# Slack export: #inc-2213-checkout (2026-10-28, times UTC)

**14:06 PagerDuty:** INC-2213 opened: Checkout errors and slowness reported by customers. Incident commander: Priya Shah.

**14:07 Priya Shah (checkout):** I'm IC. Seeing ~7% 500s on place order and p99 near 5s. Who shipped something in the last hour?

**14:08 Dana Ortiz (payments):** We rolled out payments v2.14.0 at 13:40, full at 13:47. Canary was clean though.

**14:08 Tom Becker (support):** Support queue is filling up. Customers getting "Something went wrong" at the final step. A few say they were charged but have no order. Can someone confirm?

**14:09 Priya Shah:** Payments deploy lines up time-wise. Dana, can you roll back to be safe?

**14:10 Dana Ortiz:** Our error rate is flat at 0.2% but sure, starting rollback. Latency on our side is up a bit, I think it's checkout retrying at us.

**14:12 Alex Rivera (SRE):** Heads up, log-host-03 disk alert is firing again, and search had another flap. Probably unrelated?

**14:13 Priya Shah:** Ignore those for now.

**14:14 Alex Rivera:** orders-db is basically at max connections, 397/400. Not sure if that's cause or symptom.

**14:15 Priya Shah:** Our errors are mostly orders-service 503s and inventory timeouts, a few payments retry timeouts.

**14:16 Priya Shah:** Turning off payments_retry_on_timeout to stop amplifying.

**14:20 Dana Ortiz:** Rollback to v2.13.4 done.

**14:23 Priya Shah:** Still 7%+ errors. So not payments?

**14:24 Alex Rivera:** Who would open that many DB connections? Nothing in the deploy dashboard for inventory or orders today.

**14:25 Priya Shah:** @Marcus Lee anything on inventory?

**14:27 Marcus Lee (inventory):** No deploys from us today. We did have slow stock checks earlier during the promo.

**14:28 Priya Shah:** Ok. Need a decision soon, leadership is asking for an update.
