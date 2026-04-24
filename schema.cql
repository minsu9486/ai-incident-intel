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

CREATE TABLE IF NOT EXISTS processed_messages (
  consumer_group text,
  message_id text,
  processed_at timestamp,
  PRIMARY KEY ((consumer_group), message_id)
);

CREATE TABLE IF NOT EXISTS service_health_by_org (
  org_id text,
  service_name text,
  latest_incident_id text,
  latest_event_id text,
  severity text,
  status text,
  last_updated timestamp,
  message text,
  PRIMARY KEY ((org_id), service_name)
);