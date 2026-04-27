---
id: generic-deploy-rollback
title: Generic deployment rollback procedure
services: []
severities: [HIGH, CRITICAL]
tags: [deployment, rollback, escalation]
---

When a deployment correlates in time with a metric regression and there is no obvious infra cause, prefer rollback over investigation. Rollback first, diagnose after.

1. Identify the deploy that lines up with the symptom start. Single-service deploys are clear-cut; platform-wide rollouts may need coordination across multiple teams.
2. Confirm the rollback target is known-good — the prior production image tag, not just "the previous build". Cherry-pick rollbacks that skip a hotfix can re-introduce a known bug.
3. Execute the rollback. Watch error-rate, latency, and saturation metrics for 5 minutes. If they recover, hold the rollback and start the post-incident investigation; if they do not, the deploy was probably not the cause and you have new information.
4. Open an incident ticket with the deploy SHA, rollback SHA, and the metrics window. Page the owning team only after rollback is confirmed — most rollbacks do not need an oncall page.
