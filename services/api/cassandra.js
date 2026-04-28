const cassandra = require("cassandra-driver");
const config = require("./config");
const baseLogger = require("./logger");

const logger = baseLogger.child({ module: "cassandra" });

const client = new cassandra.Client({
  contactPoints: [...config.cassandra.contactPoints],
  localDataCenter: config.cassandra.localDataCenter,
  keyspace: config.cassandra.keyspace
});

function toVector(values) {
  return new cassandra.types.Vector(Float32Array.from(values), "float");
}

let connected = false;

async function connectCassandra() {
  if (!connected) {
    await client.connect();
    connected = true;
    logger.info(
      {
        contactPoints: config.cassandra.contactPoints,
        keyspace: config.cassandra.keyspace
      },
      "connected to cassandra"
    );
  }
}

async function insertIncidentEvent(event) {
  const query = `
    INSERT INTO incident_events_by_id (
      incident_id,
      event_timestamp,
      event_id,
      event_type,
      message
    ) VALUES (?, ?, ?, ?, ?)
  `;

  const params = [
    event.incidentId,
    new Date(event.timestamp),
    event.id,
    event.type,
    event.message
  ];

  await client.execute(query, params, { prepare: true });
}

async function getIncidentTimeline(incidentId) {
  const query = `
    SELECT incident_id, event_timestamp, event_id, event_type, message
    FROM incident_events_by_id
    WHERE incident_id = ?
  `;

  const result = await client.execute(query, [incidentId], { prepare: true });

  return result.rows.map((row) => ({
    id: row.event_id,
    incidentId: row.incident_id,
    type: row.event_type,
    message: row.message,
    timestamp: row.event_timestamp.toISOString()
  }));
}

async function upsertServiceHealth(event) {
  const query = `
    INSERT INTO service_health_by_org (
      org_id,
      service_name,
      latest_incident_id,
      latest_event_id,
      severity,
      status,
      last_updated,
      message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const status = event.severity === "CRITICAL" ? "DEGRADED" : "ACTIVE";

  const params = [
    event.orgId,
    event.serviceName,
    event.incidentId,
    event.id,
    event.severity,
    status,
    new Date(event.timestamp),
    event.message
  ];

  await client.execute(query, params, { prepare: true });
}

async function getServiceHealthByOrg(orgId) {
  const query = `
    SELECT org_id, service_name, latest_incident_id, latest_event_id,
           severity, status, last_updated, message
    FROM service_health_by_org
    WHERE org_id = ?
  `;

  const result = await client.execute(query, [orgId], { prepare: true });

  return result.rows.map((row) => ({
    orgId: row.org_id,
    serviceName: row.service_name,
    latestIncidentId: row.latest_incident_id,
    latestEventId: row.latest_event_id,
    severity: row.severity,
    status: row.status,
    lastUpdated: row.last_updated.toISOString(),
    message: row.message
  }));
}

async function insertArtifactMetadata(event) {
  const query = `
    INSERT INTO artifacts_by_incident (
      incident_id,
      uploaded_at,
      artifact_id,
      bucket,
      object_key,
      original_name,
      mime_type,
      size_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    event.incidentId,
    new Date(event.timestamp),
    event.id,
    event.artifact.bucket,
    event.artifact.objectKey,
    event.artifact.originalName,
    event.artifact.mimeType,
    event.artifact.size
  ];

  await client.execute(query, params, { prepare: true });
}

async function getArtifactsByIncident(incidentId) {
  const query = `
    SELECT incident_id, uploaded_at, artifact_id, bucket, object_key,
           original_name, mime_type, size_bytes
    FROM artifacts_by_incident
    WHERE incident_id = ?
  `;

  const result = await client.execute(query, [incidentId], { prepare: true });

  return result.rows.map((row) => ({
    artifactId: row.artifact_id,
    incidentId: row.incident_id,
    bucket: row.bucket,
    objectKey: row.object_key,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    uploadedAt: row.uploaded_at.toISOString()
  }));
}

async function upsertIncidentEmbedding({
  incidentId,
  orgId,
  serviceName,
  severity,
  message,
  embeddingText,
  embedding
}) {
  const query = `
    INSERT INTO incident_embeddings (
      incident_id,
      org_id,
      service_name,
      severity,
      message,
      embedding_text,
      embedding,
      indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    incidentId,
    orgId || null,
    serviceName || null,
    severity || null,
    message || "",
    embeddingText,
    toVector(embedding),
    new Date()
  ];

  await client.execute(query, params, { prepare: true });
}

async function getIncidentLatestSnapshot(incidentId) {
  const query = `
    SELECT incident_id, org_id, service_name, severity, message
    FROM incident_embeddings
    WHERE incident_id = ?
  `;

  const result = await client.execute(query, [incidentId], { prepare: true });
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    incidentId: row.incident_id,
    orgId: row.org_id,
    serviceName: row.service_name,
    severity: row.severity,
    message: row.message
  };
}

async function findSimilarIncidentsByVector(queryEmbedding, k) {
  const overshoot = Math.max(k + 1, 1);
  const query = `
    SELECT incident_id, org_id, service_name, severity, message,
           similarity_cosine(embedding, ?) AS score
    FROM incident_embeddings
    ORDER BY embedding ANN OF ?
    LIMIT ?
  `;

  const queryVec = toVector(queryEmbedding);
  const result = await client.execute(
    query,
    [queryVec, queryVec, overshoot],
    { prepare: true }
  );

  return result.rows.map((row) => ({
    incidentId: row.incident_id,
    orgId: row.org_id,
    serviceName: row.service_name,
    severity: row.severity,
    message: row.message,
    score: row.score
  }));
}

async function upsertRunbookEmbedding({
  runbookId,
  title,
  services,
  severities,
  tags,
  content,
  embeddingText,
  embedding
}) {
  const query = `
    INSERT INTO runbook_embeddings (
      runbook_id,
      title,
      services,
      severities,
      tags,
      content,
      embedding_text,
      embedding,
      indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    runbookId,
    title,
    services || [],
    severities || [],
    tags || [],
    content,
    embeddingText,
    toVector(embedding),
    new Date()
  ];

  await client.execute(query, params, { prepare: true });
}

async function findSimilarRunbooksByVector(queryEmbedding, k, filters = {}) {
  const { serviceName, severity } = filters;
  const overshoot = Math.max(k * 4, 8);
  const query = `
    SELECT runbook_id, title, services, severities, tags, content,
           similarity_cosine(embedding, ?) AS score
    FROM runbook_embeddings
    ORDER BY embedding ANN OF ?
    LIMIT ?
  `;

  const queryVec = toVector(queryEmbedding);
  const result = await client.execute(
    query,
    [queryVec, queryVec, overshoot],
    { prepare: true }
  );

  const rows = result.rows.map((row) => ({
    runbookId: row.runbook_id,
    title: row.title,
    services: row.services || [],
    severities: row.severities || [],
    tags: row.tags || [],
    content: row.content,
    score: row.score
  }));

  return rows
    .filter((r) =>
      !serviceName || r.services.length === 0 || r.services.includes(serviceName)
    )
    .filter((r) =>
      !severity || r.severities.length === 0 || r.severities.includes(severity)
    )
    .slice(0, k);
}

async function insertIncidentByTeam(enrichedEvent) {
  const query = `
    INSERT INTO incidents_by_team (
      team_id,
      reported_at,
      incident_id,
      org_id,
      service_name,
      severity,
      severity_bucket,
      message,
      source_event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    enrichedEvent.teamId,
    new Date(enrichedEvent.timestamp),
    enrichedEvent.incidentId,
    enrichedEvent.orgId || null,
    enrichedEvent.serviceName || null,
    enrichedEvent.severity || null,
    enrichedEvent.severityBucket || null,
    enrichedEvent.message || "",
    enrichedEvent.sourceEventId || null
  ];

  await client.execute(query, params, { prepare: true });
}

async function getIncidentsByTeam(teamId, limit) {
  const query = `
    SELECT team_id, reported_at, incident_id, org_id, service_name,
           severity, severity_bucket, message, source_event_id
    FROM incidents_by_team
    WHERE team_id = ?
    LIMIT ?
  `;

  const result = await client.execute(query, [teamId, limit], { prepare: true });

  return result.rows.map((row) => ({
    incidentId: row.incident_id,
    orgId: row.org_id,
    serviceName: row.service_name,
    teamId: row.team_id,
    severity: row.severity,
    severityBucket: row.severity_bucket,
    message: row.message,
    reportedAt: row.reported_at.toISOString()
  }));
}

async function insertIncidentBySeverity(enrichedEvent) {
  const query = `
    INSERT INTO incidents_by_severity (
      severity_bucket,
      day_bucket,
      reported_at,
      incident_id,
      org_id,
      service_name,
      team_id,
      message,
      source_event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    enrichedEvent.severityBucket,
    enrichedEvent.dayBucket,
    new Date(enrichedEvent.timestamp),
    enrichedEvent.incidentId,
    enrichedEvent.orgId || null,
    enrichedEvent.serviceName || null,
    enrichedEvent.teamId || null,
    enrichedEvent.message || "",
    enrichedEvent.sourceEventId || null
  ];

  await client.execute(query, params, { prepare: true });
}

async function getIncidentsBySeverity(severityBucket, dayBucket, limit) {
  const query = `
    SELECT severity_bucket, day_bucket, reported_at, incident_id, org_id,
           service_name, team_id, message, source_event_id
    FROM incidents_by_severity
    WHERE severity_bucket = ? AND day_bucket = ?
    LIMIT ?
  `;

  const result = await client.execute(
    query,
    [severityBucket, dayBucket, limit],
    { prepare: true }
  );

  return result.rows.map((row) => ({
    incidentId: row.incident_id,
    orgId: row.org_id,
    serviceName: row.service_name,
    teamId: row.team_id,
    severity: row.severity_bucket,
    severityBucket: row.severity_bucket,
    message: row.message,
    reportedAt: row.reported_at.toISOString()
  }));
}

async function markMessageProcessed(consumerGroup, messageId) {
  const query = `
    INSERT INTO processed_messages (
      consumer_group,
      message_id,
      processed_at
    ) VALUES (?, ?, ?)
    IF NOT EXISTS
  `;

  const params = [
    consumerGroup,
    messageId,
    new Date()
  ];

  const result = await client.execute(query, params, { prepare: true });

  return result.first()["[applied]"] === true;
}

module.exports = {
  connectCassandra,
  insertIncidentEvent,
  upsertServiceHealth,
  insertArtifactMetadata,
  getIncidentTimeline,
  getServiceHealthByOrg,
  getArtifactsByIncident,
  upsertIncidentEmbedding,
  findSimilarIncidentsByVector,
  getIncidentLatestSnapshot,
  upsertRunbookEmbedding,
  findSimilarRunbooksByVector,
  insertIncidentByTeam,
  getIncidentsByTeam,
  insertIncidentBySeverity,
  getIncidentsBySeverity,
  markMessageProcessed
};