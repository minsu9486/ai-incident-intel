const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

function parseList(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseInteger(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Expected integer, got "${raw}"`);
  }
  return n;
}

function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const v = String(raw).toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`Expected boolean, got "${raw}"`);
}

function requireValue(name, value, validator) {
  if (validator(value)) return value;
  throw new Error(
    `Required env var ${name} is missing or empty. Copy .env.example to .env and fill it in.`
  );
}

const kafkaBrokers = requireValue(
  "KAFKA_BROKERS",
  parseList(process.env.KAFKA_BROKERS),
  (v) => v.length > 0
);

const cassandraContactPoints = requireValue(
  "CASSANDRA_CONTACT_POINTS",
  parseList(process.env.CASSANDRA_CONTACT_POINTS),
  (v) => v.length > 0
);

const config = Object.freeze({
  env: process.env.NODE_ENV || "development",
  logLevel: process.env.LOG_LEVEL || "info",

  kafka: Object.freeze({
    brokers: Object.freeze(kafkaBrokers),
    clientIds: Object.freeze({
      api: "ai-incident-api",
      projectionConsumer: "ai-incident-consumer",
      enrichmentConsumer: "ai-incident-enrichment-consumer",
      replayDlq: "ai-incident-dlq-replay"
    }),
    topics: Object.freeze({
      events: process.env.KAFKA_TOPIC_EVENTS || "incident-events",
      enriched: process.env.KAFKA_TOPIC_ENRICHED || "incident-enriched",
      dlq: process.env.KAFKA_TOPIC_DLQ || "incident-events-dlq"
    }),
    consumerGroups: Object.freeze({
      projection: "incident-events-projection-group",
      enrichment: "incident-enrichment-group"
    })
  }),

  cassandra: Object.freeze({
    contactPoints: Object.freeze(cassandraContactPoints),
    localDataCenter: process.env.CASSANDRA_DC || "dc1",
    keyspace: process.env.CASSANDRA_KEYSPACE || "ai_incident_intel"
  }),

  minio: Object.freeze({
    endpoint: process.env.MINIO_ENDPOINT || "localhost",
    port: parseInteger(process.env.MINIO_PORT, 9000),
    useSSL: parseBoolean(process.env.MINIO_USE_SSL, false),
    accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretKey: process.env.MINIO_SECRET_KEY || "minioadmin",
    bucket: process.env.MINIO_BUCKET || "incident-artifacts"
  }),

  api: Object.freeze({
    port: parseInteger(process.env.API_PORT, 4000)
  }),

  metrics: Object.freeze({
    projectionPort: parseInteger(process.env.METRICS_PORT_PROJECTION, 9100),
    enrichmentPort: parseInteger(process.env.METRICS_PORT_ENRICHMENT, 9101)
  }),

  gemini: Object.freeze({
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001"
  })
});

module.exports = config;
