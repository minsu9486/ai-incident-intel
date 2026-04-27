---
id: auth-secret-rotation
title: Login failures after credential rotation
services: [auth-service]
severities: [HIGH, CRITICAL]
tags: [secrets, rotation, login-failures]
---

Login failures or auth 5xx spikes that begin within minutes of a secret-rotation deploy almost always trace back to the rotation itself.

1. Confirm the rotation timing in the deploy log. Match it against the start of the failure spike — if they line up to within 1–2 minutes, treat the rotation as the cause until proven otherwise.
2. Check that the new secret was propagated to all auth-service replicas. A partial rollout where some pods hold the old secret will produce intermittent 401s rather than a clean failure.
3. If the new secret is malformed or wrong, roll back the rotation (revert to the previous secret version) before debugging further. Rotation rollback is reversible; debugging under live failures is not.
4. After recovery, force-evict the in-memory token cache so cached tokens issued under the old secret are invalidated.
