# Sample GraphQL queries

Copy-paste into Apollo Sandbox at `http://localhost:4000/graphql`. After running `npm run demo`, substitute the `incidentId` it printed for the variables marked `<demo-incidentId>`.

The full schema is browsable in Sandbox itself; this file is a quick on-ramp.

---

## Read the projection

### `incidentTimeline` — events for one incident, newest first

Reads from `incident_events_by_id`. Includes both `INCIDENT_REPORTED` events and any `ARTIFACT_ATTACHED` events that landed for the incident.

```graphql
query Timeline($id: ID!) {
  incidentTimeline(incidentId: $id) {
    id
    type
    severity
    serviceName
    message
    timestamp
  }
}
```

```json
{ "id": "<demo-incidentId>" }
```

---

### `serviceHealthByOrg` — latest-state view per service

Reads from `service_health_by_org`, an upsert-style projection of "what's the current health of each service in this org?".

```graphql
query Health($org: ID!) {
  serviceHealthByOrg(orgId: $org) {
    serviceName
    severity
    status
    lastUpdated
    latestIncidentId
    message
  }
}
```

```json
{ "org": "demo-org" }
```

---

### `incidentsByTeam` — team-scoped view

Reads from `incidents_by_team`, populated from `INCIDENT_ENRICHED` events. Team IDs are computed by the enrichment consumer from `serviceName` (see `services/api/teams.js`); `payments-api` maps to `payments`.

```graphql
query Team($team: String!) {
  incidentsByTeam(teamId: $team, limit: 10) {
    incidentId
    serviceName
    severity
    severityBucket
    reportedAt
    message
  }
}
```

```json
{ "team": "payments" }
```

---

### `incidentsBySeverity` — triage view

Reads from `incidents_by_severity`. The compound partition key `(severity_bucket, day_bucket)` keeps any single severity bucket from growing an unbounded partition.

```graphql
query Triage($sev: String!, $day: String!) {
  incidentsBySeverity(severityBucket: $sev, day: $day, limit: 10) {
    incidentId
    teamId
    serviceName
    reportedAt
    message
  }
}
```

```json
{ "sev": "CRITICAL", "day": "YYYY-MM-DD" }
```

(Use the day the demo was run, in `YYYY-MM-DD`.)

---

### `incidentArtifacts` — files attached to an incident

Each `IncidentArtifact.downloadUrl` is a freshly-generated 15-minute MinIO presigned URL.

```graphql
query Artifacts($id: ID!) {
  incidentArtifacts(incidentId: $id) {
    artifactId
    originalName
    mimeType
    sizeBytes
    uploadedAt
    downloadUrl
  }
}
```

```json
{ "id": "<demo-incidentId>" }
```

---

## AI layer

### `incidentSummary` — Gemini-generated structured summary

Pulls the last `limit` events plus the org's current `serviceHealthByOrg` rows for context, asks Gemini for a structured JSON summary.

```graphql
query Summarize($id: ID!, $org: ID) {
  incidentSummary(incidentId: $id, orgId: $org, limit: 20) {
    summary
    customerImpact
    likelyRootCause
    confidence
    nextActions
    signals
  }
}
```

```json
{ "id": "<demo-incidentId>", "org": "demo-org" }
```

---

### `similarIncidents` — vector ANN search

Embeds the query message via Gemini, runs an ANN cosine search over `incident_embeddings` (Cassandra 5 `VECTOR<FLOAT, 768>` + SAI index), filters out the self-match.

```graphql
query Similar($id: ID!, $msg: String!, $svc: String, $sev: String) {
  similarIncidents(
    incidentId: $id
    serviceName: $svc
    severity: $sev
    message: $msg
    k: 3
  ) {
    incidentId
    serviceName
    severity
    score
    message
  }
}
```

```json
{
  "id": "<demo-incidentId>",
  "msg": "Payments API timing out after deployment; postgres connection errors and elevated p95 latency.",
  "svc": "payments-api",
  "sev": "CRITICAL"
}
```

---

### `recommendedActions` — runbook RAG

Retrieves similar incidents + nearest runbook chunks in parallel, asks Gemini for exactly 3 priority-sorted actions with `confidence` and `risk` in `{LOW, MEDIUM, HIGH}`.

```graphql
query Actions($id: ID!) {
  recommendedActions(incidentId: $id, k: 3) {
    actions {
      priority
      action
      reason
      confidence
      risk
    }
    notes
  }
}
```

```json
{ "id": "<demo-incidentId>" }
```

---

## Mutation

### `createIncident` — write side

Publishes an `INCIDENT_REPORTED` event to the `incident-events` Kafka topic; the projection appears in `incidentTimeline` after the consumer processes it (typically <1s on a local stack).

```graphql
mutation Create($input: CreateIncidentInput!) {
  createIncident(input: $input) {
    success
    event { id incidentId timestamp }
  }
}
```

```json
{
  "input": {
    "incidentId": "manual-demo-1",
    "orgId": "demo-org",
    "serviceName": "payments-api",
    "severity": "HIGH",
    "message": "Payments API connection timeouts spiking after release."
  }
}
```
