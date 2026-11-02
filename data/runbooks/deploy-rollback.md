# Runbook: Rolling back a deploy

**Owner:** platform · **Last reviewed:** 2026-05-02

1. Confirm the deploy correlates with the symptom: errors should start within minutes of the rollout reaching 100%, and the deployed service's own error rate should rise.
2. Check canary results. A passed canary makes a code regression less likely but not impossible.
3. Roll back with `deployctl rollback <service> --to <version>`.
4. Watch the service's error rate for 10 minutes. If symptoms don't improve, the deploy was likely not the cause; record that in the incident timeline.
