const cassandra = require("cassandra-driver");

const client = new cassandra.Client({
  contactPoints: ["127.0.0.1"],
  localDataCenter: "dc1",
  keyspace: "ai_incident_intel"
});

let connected = false;

async function connectCassandra() {
  if (!connected) {
    await client.connect();
    connected = true;
    console.log("Connected to Cassandra");
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
  markMessageProcessed
};