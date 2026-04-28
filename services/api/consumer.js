const config = require("./config");
const baseLogger = require("./logger");
const { Kafka } = require("kafkajs");
const {
  connectCassandra,
  insertIncidentEvent,
  upsertServiceHealth,
  insertArtifactMetadata,
  upsertIncidentEmbedding,
  insertIncidentByTeam,
  insertIncidentBySeverity,
  markMessageProcessed
} = require("./cassandra");
const { publishToDlq } = require("./kafka");
const {
  buildIncidentEmbeddingText,
  embedDocument
} = require("./embeddings");
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

const CONSUMER_GROUP = config.kafka.consumerGroups.projection;

const logger = baseLogger.child({
  service: "projection-consumer",
  consumerGroup: CONSUMER_GROUP
});

const kafka = new Kafka({
  clientId: config.kafka.clientIds.projectionConsumer,
  brokers: [...config.kafka.brokers]
});

const consumer = kafka.consumer({
  groupId: CONSUMER_GROUP
});

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processIncidentEvent(event, log) {
  if (event.message.includes("FORCE_DLQ")) {
    throw new Error("Forced failure for DLQ test");
  }

  const wasMarked = await markMessageProcessed(CONSUMER_GROUP, event.id);

  if (!wasMarked) {
    log.info("skipping duplicate event");
    return;
  }

  switch (event.type) {
    case "INCIDENT_REPORTED":
      await insertIncidentEvent(event);
      await upsertServiceHealth(event);
      await tryIndexIncidentEmbedding(event, log);
      return;
    case "ARTIFACT_ATTACHED":
      await insertArtifactMetadata(event);
      return;
    case "INCIDENT_ENRICHED":
      await insertIncidentByTeam(event);
      await insertIncidentBySeverity(event);
      return;
    default:
      log.warn({ eventType: event.type }, "ignoring unknown event type");
  }
}

async function tryIndexIncidentEmbedding(event, log) {
  const startedAt = Date.now();
  try {
    const embeddingText = buildIncidentEmbeddingText({
      incidentId: event.incidentId,
      orgId: event.orgId,
      serviceName: event.serviceName,
      severity: event.severity,
      message: event.message
    });
    const embedding = await embedDocument(embeddingText);
    await upsertIncidentEmbedding({
      incidentId: event.incidentId,
      orgId: event.orgId,
      serviceName: event.serviceName,
      severity: event.severity,
      message: event.message,
      embeddingText,
      embedding
    });
    log.info({ durationMs: Date.now() - startedAt }, "indexed incident embedding");
  } catch (error) {
    log.warn(
      { err: error.message },
      "embedding step skipped (best-effort, projection still landed)"
    );
  }
}

async function processWithRetry(event, kafkaMetadata, log) {
  let lastError;
  const endTimer = startProcessingTimer(CONSUMER_GROUP);

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        await processIncidentEvent(event, log);
        log.info({ attempt }, "processed event");
        observeEndToEndLag(CONSUMER_GROUP, event.timestamp);
        return;
      } catch (error) {
        lastError = error;
        recordRetry(CONSUMER_GROUP);
        log.error(
          { attempt, maxRetries: MAX_RETRIES, err: error.message },
          "process attempt failed"
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
      originalTopic: kafkaMetadata.topic,
      originalPartition: kafkaMetadata.partition,
      originalOffset: kafkaMetadata.offset,
      originalMessage: event
    };

    await publishToDlq(dlqPayload);
    recordDlq(CONSUMER_GROUP, "retry-exhausted");

    log.error(
      { retryCount: MAX_RETRIES },
      "moved event to DLQ after retry exhaustion"
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

  await consumer.subscribe({
    topic: config.kafka.topics.enriched,
    fromBeginning: true
  });

  startMetricsServer({
    port: config.metrics.projectionPort,
    name: "projection-consumer"
  });

  const admin = kafka.admin();
  await admin.connect();
  startKafkaLagPoller({
    admin,
    topics: [config.kafka.topics.events, config.kafka.topics.enriched],
    consumerGroup: CONSUMER_GROUP
  });

  logger.info("kafka consumer is running");

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
          ...messageMeta
        });

        log.debug("received message");

        await processWithRetry(event, messageMeta, log);
      } catch (error) {
        const log = logger.child({ ...messageMeta, incidentId: "unknown" });
        log.error({ err: error.message }, "failed to parse kafka message");

        const fallbackDlqPayload = {
          incidentId: "unknown",
          failedAt: new Date().toISOString(),
          retryCount: 0,
          errorMessage: error.message,
          originalTopic: topic,
          originalPartition: partition,
          originalOffset: message.offset,
          originalRawValue: message.value ? message.value.toString() : null
        };

        try {
          await publishToDlq(fallbackDlqPayload);
          recordDlq(CONSUMER_GROUP, "malformed-json");
          log.error("moved malformed message to DLQ");
        } catch (dlqError) {
          log.fatal({ err: dlqError.message }, "failed to publish malformed message to DLQ");
          throw dlqError;
        }
      }
    }
  });
}

if (require.main === module) {
  startConsumer().catch((error) => {
    logger.fatal({ err: error.message, stack: error.stack }, "consumer failed to start");
    process.exit(1);
  });
}

module.exports = {
  CONSUMER_GROUP,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  processIncidentEvent,
  processWithRetry
};