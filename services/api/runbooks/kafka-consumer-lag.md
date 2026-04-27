---
id: kafka-consumer-lag
title: Kafka consumer lag and projection delay
services: []
severities: [LOW, HIGH, CRITICAL]
tags: [kafka, consumer, lag, projection]
---

Growing Kafka consumer lag means the projection is falling behind the topic. Read-side queries will return stale data until the consumer catches up.

1. Identify which consumer group is lagging via `kafka-consumer-groups --describe`. Check whether lag is on every partition (consumer-wide problem) or one partition (hot key or partition-specific issue).
2. Check the consumer process: CPU, GC pauses, log error rate. A consumer crashing in a tight loop will look like lag from the broker side.
3. If the consumer is healthy but the workload is genuinely heavier than capacity, scale consumer instances up to the partition count. Beyond that, increasing partitions is the next lever — coordinate with the team owning the topic.
4. If the lag was triggered by a poison-pill message, check the DLQ. The replay tool can republish DLQ'd messages once the underlying handler is fixed.
