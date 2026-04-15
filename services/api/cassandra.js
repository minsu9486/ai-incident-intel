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

module.exports = {
  connectCassandra,
  insertIncidentEvent,
  getIncidentTimeline
};