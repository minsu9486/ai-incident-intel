---
id: payments-db-saturation
title: Payments database saturation and connection errors
services: [payments-api]
severities: [HIGH, CRITICAL]
tags: [database, postgres, saturation]
---

Connection timeouts to postgres-primary from payments-api typically mean either the primary is saturated or the connection pool is leaking. Treat this as a load-shedding situation, not an immediate failover.

1. Check postgres-primary CPU, active connection count, and slow-query log. A CPU above 85% sustained or active connections near `max_connections` is the smoking gun.
2. If the load is from a known query, kill the offending session with `pg_terminate_backend` and rate-limit the upstream caller via the API gateway.
3. Do not fail over to the read replica unless primary health is degraded — replica lag may be high, and a failover under load can compound the incident.
4. If saturation persists after shedding load, scale the primary vertically or shift non-critical reads to the replica. Coordinate with #data-platform before changing replication topology.
