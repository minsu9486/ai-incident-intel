const { Kafka } = require("kafkajs");

const kafka = new Kafka({
  clientId: "ai-incident-api",
  brokers: ["localhost:9092"]
});

const producer = kafka.producer();
const admin = kafka.admin();

let producerConnected = false;

async function ensureTopicExists(topic) {
  await admin.connect();

  const topics = await admin.listTopics();

  if (!topics.includes(topic)) {
    await admin.createTopics({
      topics: [
        {
          topic,
          numPartitions: 1,
          replicationFactor: 1
        }
      ]
    });
  }

  await admin.disconnect();
}

async function connectProducer() {
  if (!producerConnected) {
    await producer.connect();
    producerConnected = true;
  }
}

async function sendJsonMessage(topic, key, payload, headers = {}) {
  await ensureTopicExists(topic);
  await connectProducer();

  await producer.send({
    topic,
    messages: [
      {
        key,
        value: JSON.stringify(payload),
        headers
      }
    ]
  });
}

async function publishIncidentReported(event) {
  await sendJsonMessage("incident-events", event.incidentId, event);
}

async function publishToDlq(dlqPayload) {
  await sendJsonMessage(
    "incident-events-dlq",
    dlqPayload.incidentId || "unknown",
    dlqPayload
  );
}

module.exports = {
  publishIncidentReported,
  publishToDlq,
  sendJsonMessage
};