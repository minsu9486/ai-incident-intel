const { Kafka } = require("kafkajs");
const config = require("./config");
const { recordPublished } = require("./metrics");

const kafka = new Kafka({
  clientId: config.kafka.clientIds.api,
  brokers: [...config.kafka.brokers]
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

  recordPublished(topic);
}

async function publishIncidentReported(event) {
  await sendJsonMessage(config.kafka.topics.events, event.incidentId, event);
}

async function publishArtifactAttached(event) {
  await sendJsonMessage(config.kafka.topics.events, event.incidentId, event);
}

async function publishIncidentEnriched(event) {
  await sendJsonMessage(config.kafka.topics.enriched, event.incidentId, event);
}

async function publishToDlq(dlqPayload) {
  await sendJsonMessage(
    config.kafka.topics.dlq,
    dlqPayload.incidentId || "unknown",
    dlqPayload
  );
}

module.exports = {
  publishIncidentReported,
  publishArtifactAttached,
  publishIncidentEnriched,
  publishToDlq,
  sendJsonMessage
};