const config = require("./config");
const baseLogger = require("./logger");
const crypto = require("crypto");
const { Kafka } = require("kafkajs");
const { GoogleGenAI } = require("@google/genai");
const {
  connectCassandra,
  markMessageProcessed
} = require("./cassandra");
const { publishIncidentEnriched, publishToDlq } = require("./kafka");
const { lookupTeamId } = require("./teams");
const {
  recordConsumed,
  recordRetry,
  recordDlq,
  startProcessingTimer,
  observeEndToEndLag,
  startMetricsServer,
  startKafkaLagPoller,
  attachKafkajsConsumerEventMetrics
} = require("./metrics");

const CONSUMER_GROUP = config.kafka.consumerGroups.enrichment;

const logger = baseLogger.child({
  service: "enrichment-consumer",
  consumerGroup: CONSUMER_GROUP
});

const kafka = new Kafka({
  clientId: config.kafka.clientIds.enrichmentConsumer,
  brokers: [...config.kafka.brokers]
});

const consumer = kafka.consumer({
  groupId: CONSUMER_GROUP
});

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const SEVERITY_BUCKETS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const DEFAULT_SEVERITY_BUCKET = "MEDIUM";

let geminiClient;

function getGeminiClient() {
  if (geminiClient) return geminiClient;
  if (!config.gemini.apiKey) return null;
  geminiClient = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return geminiClient;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSeverityBucket(severity) {
  if (!severity) return DEFAULT_SEVERITY_BUCKET;
  const upper = String(severity).toUpperCase();
  return SEVERITY_BUCKETS.has(upper) ? upper : DEFAULT_SEVERITY_BUCKET;
}

function computeDayBucket(isoTimestamp) {
  const d = new Date(isoTimestamp);
  return d.toISOString().slice(0, 10);
}

async function tryGenerateSeverityHint({ serviceName, severity, message }, log) {
  const client = getGeminiClient();
  if (!client) return null;

  const startedAt = Date.now();
  try {
    const prompt = [
      "You classify incident severity for an SRE platform.",
      `Service: ${serviceName || "unknown"}`,
      `Reported severity: ${severity || "unknown"}`,
      `Message: ${message || ""}`,
      "",
      "Reply with exactly one of: LOW, MEDIUM, HIGH, CRITICAL.",
      "No prose, no punctuation, no explanation."
    ].join("\n");

    const response = await client.models.generateContent({
      model: config.gemini.model,
      contents: prompt,
      config: { temperature: 0 }
    });

    const text = (response.text || "").trim().toUpperCase();
    const match = text.match(/\b(LOW|MEDIUM|HIGH|CRITICAL)\b/);
    const hint = match ? match[1] : null;

    log.info(
      { serviceName, hint: hint || "unparseable", durationMs: Date.now() - startedAt },
      "severity hint generated"
    );
    return hint;
  } catch (error) {
    log.warn({ serviceName, err: error.message }, "severity hint skipped");
    return null;
  }
}

function buildEnrichedEvent({ source, teamId, severityBucket, aiSeverityHint }) {
  return {
    id: crypto.randomUUID(),
    incidentId: source.incidentId,
    orgId: source.orgId || null,
    serviceName: source.serviceName || null,
    severity: source.severity || null,
    type: "INCIDENT_ENRICHED",
    message: source.message || "",
    timestamp: source.timestamp,
    teamId,
    severityBucket,
    dayBucket: computeDayBucket(source.timestamp),
    aiSeverityHint,
    enrichedAt: new Date().toISOString(),
    sourceEventId: source.id
  };
}

async function enrichIncidentEvent(event, log) {
  if (event.type !== "INCIDENT_REPORTED") {
    return;
  }

  if (typeof event.message === "string" && event.message.includes("BREAK_ENRICH")) {
    throw new Error("Forced enrichment failure for DLQ test");
  }

  const wasMarked = await markMessageProcessed(CONSUMER_GROUP, event.id);
  if (!wasMarked) {
    log.info("skipping duplicate event in enrichment group");
    return;
  }

  const teamId = lookupTeamId(event.serviceName);
  const severityBucket = normalizeSeverityBucket(event.severity);
  const aiSeverityHint = await tryGenerateSeverityHint(
    {
      serviceName: event.serviceName,
      severity: event.severity,
      message: event.message
    },
    log
  );

  const enriched = buildEnrichedEvent({
    source: event,
    teamId,
    severityBucket,
    aiSeverityHint
  });

  await publishIncidentEnriched(enriched);

  log.info(
    { teamId, severityBucket, aiSeverityHint: aiSeverityHint || null },
    "enriched incident"
  );
}

async function processWithRetry(event, kafkaMetadata, log) {
  let lastError;
  const endTimer = startProcessingTimer(CONSUMER_GROUP);

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        await enrichIncidentEvent(event, log);
        log.info({ attempt }, "enrichment processed event");
        observeEndToEndLag(CONSUMER_GROUP, event.timestamp);
        return;
      } catch (error) {
        lastError = error;
        recordRetry(CONSUMER_GROUP);
        log.error(
          { attempt, maxRetries: MAX_RETRIES, err: error.message },
          "enrichment attempt failed"
        );

        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }

    const dlqPayload = {
      incidentId: event.incidentId,
      failedAt: new Date().toISOString(),
      retryCount: MAX_RETRIES,
      errorMessage: lastError.message,
      failedConsumerGroup: CONSUMER_GROUP,
      originalTopic: kafkaMetadata.topic,
      originalPartition: kafkaMetadata.partition,
      originalOffset: kafkaMetadata.offset,
      originalMessage: event
    };

    await publishToDlq(dlqPayload);
    recordDlq(CONSUMER_GROUP, "retry-exhausted");

    log.error(
      { retryCount: MAX_RETRIES },
      "enrichment moved event to DLQ after retry exhaustion"
    );
  } finally {
    endTimer();
  }
}

async function startConsumer() {
  await connectCassandra();
  await consumer.connect();

  attachKafkajsConsumerEventMetrics(consumer, CONSUMER_GROUP);

  await consumer.subscribe({
    topic: config.kafka.topics.events,
    fromBeginning: true
  });

  startMetricsServer({
    port: config.metrics.enrichmentPort,
    name: "enrichment-consumer"
  });

  const admin = kafka.admin();
  await admin.connect();
  startKafkaLagPoller({
    admin,
    topics: [config.kafka.topics.events],
    consumerGroup: CONSUMER_GROUP
  });

  logger.info("kafka enrichment consumer is running");

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const messageMeta = { topic, partition, offset: message.offset };
      recordConsumed(topic, CONSUMER_GROUP);
      try {
        const rawValue = message.value.toString();
        const event = JSON.parse(rawValue);

        const log = logger.child({
          incidentId: event.incidentId,
          eventId: event.id,
          eventType: event.type,
          ...messageMeta
        });

        log.debug("enrichment received message");

        await processWithRetry(event, messageMeta, log);
      } catch (error) {
        const log = logger.child({ ...messageMeta, incidentId: "unknown" });
        log.error({ err: error.message }, "enrichment failed to parse kafka message");

        const fallbackDlqPayload = {
          incidentId: "unknown",
          failedAt: new Date().toISOString(),
          retryCount: 0,
          errorMessage: error.message,
          failedConsumerGroup: CONSUMER_GROUP,
          originalTopic: topic,
          originalPartition: partition,
          originalOffset: message.offset,
          originalRawValue: message.value ? message.value.toString() : null
        };

        try {
          await publishToDlq(fallbackDlqPayload);
          recordDlq(CONSUMER_GROUP, "malformed-json");
          log.error("enrichment moved malformed message to DLQ");
        } catch (dlqError) {
          log.fatal({ err: dlqError.message }, "enrichment failed to publish malformed message to DLQ");
          throw dlqError;
        }
      }
    }
  });
}

startConsumer().catch((error) => {
  logger.fatal({ err: error.message, stack: error.stack }, "enrichment consumer failed to start");
  process.exit(1);
});
