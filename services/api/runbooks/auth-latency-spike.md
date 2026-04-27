---
id: auth-latency-spike
title: Auth service latency spike
services: [auth-service]
severities: [HIGH, CRITICAL]
tags: [latency, cache, identity-provider]
---

A sudden p95 latency spike on auth-service is usually one of: cache miss storm, downstream identity-provider slowness, or a recent secret rotation invalidating the in-memory token cache.

1. Check cache hit rate over the last hour. A sharp drop (e.g., 95% → 60%) points at a cache invalidation event — confirm against recent deploys and secret-rotation jobs.
2. Inspect downstream identity-provider latency (Auth0/Okta dashboards). If their p95 is also degraded, this is a vendor incident — switch to the cached-only auth path if that flag exists.
3. Verify recent deploys to auth-service. A bad config push that disables the token cache will look identical to a vendor outage from the symptom side.
4. Do not bounce auth-service pods unless explicitly necessary — restarting will cold-cache and worsen the spike.
