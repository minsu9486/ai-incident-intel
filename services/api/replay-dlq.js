const config = require("./config");
const baseLogger = require("./logger");
const { Kafka } = require("kafkajs");
const { sendJsonMessage } = require("./kafka");

const logger = baseLogger.child({ service: "replay-dlq" });

const kafka = new Kafka({
  clientId: config.kafka.clientIds.replayDlq,
  brokers: [...config.kafka.brokers]
});

const consumer = kafka.consumer({
  groupId: `incident-events-dlq-replay-${Date.now()}`
});

const admin = kafka.admin();

async function ensureTopicExists(topic) {
  await admin.connect();

  const topics = await admin.listTopics();

  if (!topics.includes(topic)) {
    throw new Error(`Topic "${topic}" does not exist yet. Create a DLQ message first.`);
  }

  await admin.disconnect();
}

async function replayDlqMessages() {
  await ensureTopicExists(config.kafka.topics.dlq);

  await consumer.connect();

  await consumer.subscribe({
    topic: config.kafka.topics.dlq,
    fromBeginning: true
  });

  logger.info("reading DLQ messages for replay");

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const rawValue = message.value.toString();
      const dlqPayload = JSON.parse(rawValue);
      const log = logger.child({ topic, partition, offset: message.offset });

      if (!dlqPayload.originalMessage) {
        log.warn("skipping DLQ message — no originalMessage");
        return;
      }

      await sendJsonMessage(
        config.kafka.topics.events,
        dlqPayload.originalMessage.incidentId,
        dlqPayload.originalMessage,
        {
          replayedFromDlq: "true"
        }
      );

      log.info(
        { incidentId: dlqPayload.originalMessage.incidentId },
        "replayed message from DLQ"
      );
    }
  });
}

replayDlqMessages().catch((error) => {
  logger.fatal({ err: error.message, stack: error.stack }, "DLQ replay failed");
  process.exit(1);
});