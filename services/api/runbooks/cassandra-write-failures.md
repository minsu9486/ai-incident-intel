---
id: cassandra-write-failures
title: Cassandra write failures and timeouts
services: []
severities: [HIGH, CRITICAL]
tags: [cassandra, writes, timeouts]
---

Write timeouts or `WriteFailure` errors from a Cassandra-backed service can mean: a node is down, the coordinator is overloaded, or the consistency level cannot be met by the live replicas.

1. Check `nodetool status` and node health. A DN (down) node with consistency level QUORUM on RF=3 will surface as intermittent write failures, not a hard outage.
2. Inspect coordinator load. A hot partition or a runaway tombstone scan can pin one coordinator and cause symptom-level write timeouts.
3. If a node is genuinely down and recovery will take time, reduce write consistency to ONE only as a temporary measure — and only with explicit approval. Document the reduction and revert as soon as the cluster recovers.
4. Do not run `nodetool repair` during an active incident; it amplifies load. Schedule repair after the cluster is stable.
