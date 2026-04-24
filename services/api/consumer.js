const { Kafka } = require("kafkajs");
const {
  connectCassandra,
  insertIncidentEvent,
  upsertServiceHealth,
  markMessageProcessed
} = require("./cassandra");
const { publishToDlq } = require("./kafka");

const kafka = new Kafka({
  clientId: "ai-incident-consumer",
  brokers: ["localhost:9092"]
});

const CONSUMER_GROUP = "incident-events-projection-group";

const consumer = kafka.consumer({
  groupId: CONSUMER_GROUP
});

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processIncidentEvent(event) {
  if (event.message.includes("FORCE_DLQ")) {
    throw new Error("Forced failure for DLQ test");
  }

  const wasMarked = await markMessageProcessed(CONSUMER_GROUP, event.id);

  if (!wasMarked) {
    console.log(`Skipping duplicate event ${event.id}`);
    return;
  }

  await insertIncidentEvent(event);
  await upsertServiceHealth(event);
}

async function processWithRetry(event, kafkaMetadata) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await processIncidentEvent(event);

      console.log(
        `Processed event ${event.id} on attempt ${attempt}`
      );

      return;
    } catch (error) {
      lastError = error;

      console.error(
        `Attempt ${attempt}/${MAX_RETRIES} failed for incidentId=${event.incidentId}:`,
        error.message
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

  console.error(
    `Moved event ${event.id} to DLQ after ${MAX_RETRIES} attempts`
  );
}

async function startConsumer() {
  await connectCassandra();
  await consumer.connect();

  await consumer.subscribe({
    topic: "incident-events",
    fromBeginning: true
  });

  console.log("Kafka consumer is running...");

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const rawValue = message.value.toString();
        const event = JSON.parse(rawValue);

        console.log(
          `Received message ${topic}[${partition}] offset=${message.offset} eventId=${event.id}`
        );

        await processWithRetry(event, {
          topic,
          partition,
          offset: message.offset
        });
      } catch (error) {
        console.error("Failed to process Kafka message:", error);

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
          console.error(
            `Moved malformed message at offset ${message.offset} to DLQ`
          );
        } catch (dlqError) {
          console.error("Failed to publish malformed message to DLQ:", dlqError);
          throw dlqError;
        }
      }
    }
  });
}

startConsumer().catch((error) => {
  console.error("Consumer failed to start:", error);
});