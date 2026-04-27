---
id: payments-timeout-after-deploy
title: Payments API timeout spike after deployment
services: [payments-api]
severities: [HIGH, CRITICAL]
tags: [deployment, rollback, timeouts]
---

When payments-api timeout rate spikes shortly after a deployment, suspect a regression in the new build or a misconfigured connection pool.

1. Compare current deployment config to the previous one: image tag, env vars, secret versions, and feature flags. Diff against the last known-good revision.
2. Check connection pool saturation on the database client. Look for `pool exhausted` or `acquire timeout` log lines and verify max pool size matches the new replica count.
3. If timeout rate stays above 5% for 10 minutes, roll back to the prior image tag. Rollback is safe; the new build has not been promoted to a long-running worker.
4. Page #payments-oncall immediately if rollback does not recover within 5 minutes — there may be a downstream dependency (postgres-primary, redis) that needs intervention.
