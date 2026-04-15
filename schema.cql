CREATE KEYSPACE IF NOT EXISTS ai_incident_intel
WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

USE ai_incident_intel;

CREATE TABLE IF NOT EXISTS incident_events_by_id (
  incident_id text,
  event_timestamp timestamp,
  event_id text,
  event_type text,
  message text,
  PRIMARY KEY ((incident_id), event_timestamp, event_id)
) WITH CLUSTERING ORDER BY (event_timestamp DESC, event_id ASC);