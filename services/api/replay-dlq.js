const { Kafka } = require("kafkajs");
const { sendJsonMessage } = require("./kafka");

const kafka = new Kafka({
  clientId: "ai-incident-dlq-replay",
  brokers: ["localhost:9092"]
});

const consumer = kafka.consumer({
  groupId: `incident-events-dlq-replay-${Date.now()}`
});

async function replayDlqMessages() {
  await consumer.connect();

  await consumer.subscribe({
    topic: "incident-events-dlq",
    fromBeginning: true
  });

  console.log("Reading DLQ messages for replay...");

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const rawValue = message.value.toString();
      const dlqPayload = JSON.parse(rawValue);

      if (!dlqPayload.originalMessage) {
        console.log(
          `Skipping DLQ message at ${topic}[${partition}] offset=${message.offset} because it has no originalMessage`
        );
        return;
      }

      await sendJsonMessage(
        "incident-events",
        dlqPayload.originalMessage.incidentId,
        dlqPayload.originalMessage,
        {
          replayedFromDlq: "true"
        }
      );

      console.log(
        `Replayed incidentId=${dlqPayload.originalMessage.incidentId} from DLQ offset=${message.offset}`
      );
    }
  });
}

replayDlqMessages().catch((error) => {
  console.error("DLQ replay failed:", error);
});