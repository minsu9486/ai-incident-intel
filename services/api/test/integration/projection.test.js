/**
 * Integration test for the projection consumer.
 *
 * Uses **compose-as-harness** mode — assumes `docker compose up -d` is running
 * and `schema.cql` has been applied (idempotent). Future upgrade path:
 * @testcontainers/cassandra and @testcontainers/kafka for self-contained CI.
 *
 * Asserts:
 *   1. An INCIDENT_REPORTED event projects into `incident_events_by_id`.
 *   2. A message containing FORCE_DLQ ends in the DLQ after retry exhaustion.
 *
 * Each run uses unique UUIDs so reruns never collide. The test imports
 * `processWithRetry` from `consumer.js` and runs it in-process under a unique
 * Kafka consumer group, so it can run alongside (or in place of) the
 * standalone consumer process without conflict.
 */

const crypto = require("crypto");
const { Kafka } = require("kafkajs");

// Ensure the config module loads with valid env vars even if .env is missing.
process.env.KAFKA_BROKERS ||= "localhost:9092";
process.env.CASSANDRA_CONTACT_POINTS ||= "127.0.0.1";
process.env.LOG_LEVEL = "error"; // keep test output quiet

const config = require("../../config");
const baseLogger = require("../../logger");
const {
  connectCassandra,
  getIncidentTimeline
} = require("../../cassandra");
const { publishIncidentReported } = require("../../kafka");
const { processWithRetry, MAX_RETRIES, RETRY_DELAY_MS } = require("../../consumer");

jest.setTimeout(90000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("projection consumer integration", () => {
  const testGroupId = `it-projection-${crypto.randomUUID()}`;
  const dlqGroupId = `it-dlq-${crypto.randomUUID()}`;

  let kafka;
  let projectionConsumer;
  let dlqConsumer;
  const dlqMessages = [];

  async function waitForAssignment(consumer) {
    await new Promise((resolve) => {
      consumer.on(consumer.events.GROUP_JOIN, () => resolve());
    });
  }

  beforeAll(async () => {
    await connectCassandra();

    kafka = new Kafka({
      clientId: "it-test",
      brokers: [...config.kafka.brokers]
    });

    projectionConsumer = kafka.consumer({ groupId: testGroupId });
    await projectionConsumer.connect();
    await projectionConsumer.subscribe({
      topic: config.kafka.topics.events,
      fromBeginning: false
    });
    const projectionAssigned = waitForAssignment(projectionConsumer);
    const log = baseLogger.child({ test: "projection" });
    await projectionConsumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const event = JSON.parse(message.value.toString());
        await processWithRetry(
          event,
          { topic, partition, offset: message.offset },
          log
        );
      }
    });
    await projectionAssigned;

    dlqConsumer = kafka.consumer({ groupId: dlqGroupId });
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({
      topic: config.kafka.topics.dlq,
      fromBeginning: false
    });
    const dlqAssigned = waitForAssignment(dlqConsumer);
    await dlqConsumer.run({
      eachMessage: async ({ message }) => {
        try {
          dlqMessages.push(JSON.parse(message.value.toString()));
        } catch (e) {
          // ignore malformed DLQ entries
        }
      }
    });
    await dlqAssigned;
  });

  afterAll(async () => {
    if (projectionConsumer) await projectionConsumer.disconnect();
    if (dlqConsumer) await dlqConsumer.disconnect();
  });

  test("INCIDENT_REPORTED projects into incident_events_by_id", async () => {
    const incidentId = `it-${crypto.randomUUID()}`;
    const event = {
      id: crypto.randomUUID(),
      incidentId,
      orgId: "it-org",
      serviceName: "it-svc",
      severity: "HIGH",
      type: "INCIDENT_REPORTED",
      message: "integration test happy path",
      timestamp: new Date().toISOString()
    };

    await publishIncidentReported(event);

    let timeline = [];
    for (let i = 0; i < 30; i += 1) {
      timeline = await getIncidentTimeline(incidentId);
      if (timeline.length > 0) break;
      await sleep(1000);
    }

    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline[0].id).toBe(event.id);
    expect(timeline[0].type).toBe("INCIDENT_REPORTED");
    expect(timeline[0].message).toBe("integration test happy path");
  });

  test("event containing FORCE_DLQ lands in the DLQ after retries", async () => {
    const incidentId = `it-dlq-${crypto.randomUUID()}`;
    const event = {
      id: crypto.randomUUID(),
      incidentId,
      orgId: "it-org",
      serviceName: "it-svc",
      severity: "HIGH",
      type: "INCIDENT_REPORTED",
      message: "FORCE_DLQ integration test",
      timestamp: new Date().toISOString()
    };

    await publishIncidentReported(event);

    // 3 attempts × linear backoff = 1s + 2s + 3s = ~6s before DLQ publish.
    const totalRetryMs = (MAX_RETRIES * (MAX_RETRIES + 1) * RETRY_DELAY_MS) / 2;
    const deadline = Date.now() + totalRetryMs + 30000;
    let dlqEntry;
    while (Date.now() < deadline) {
      dlqEntry = dlqMessages.find(
        (m) => m.originalMessage && m.originalMessage.id === event.id
      );
      if (dlqEntry) break;
      await sleep(500);
    }

    expect(dlqEntry).toBeDefined();
    expect(dlqEntry.retryCount).toBe(MAX_RETRIES);
    expect(dlqEntry.errorMessage).toContain("Forced failure");
    expect(dlqEntry.originalMessage.incidentId).toBe(incidentId);
  });
});
