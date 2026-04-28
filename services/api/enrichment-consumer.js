require("dotenv").config();

const crypto = require("crypto");
const { Kafka } = require("kafkajs");
const { GoogleGenAI } = require("@google/genai");
const {
  connectCassandra,
  markMessageProcessed
} = require("./cassandra");
const { publishIncidentEnriched, publishToDlq } = require("./kafka");
const { lookupTeamId } = require("./teams");

const kafka = new Kafka({
  clientId: "ai-incident-enrichment-consumer",
  brokers: ["localhost:9092"]
});

const CONSUMER_GROUP = "incident-enrichment-group";

const consumer = kafka.consumer({
  groupId: CONSUMER_GROUP
});

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const SEVERITY_BUCKETS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const DEFAULT_SEVERITY_BUCKET = "MEDIUM";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

let geminiClient;

function getGeminiClient() {
  if (geminiClient) return geminiClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  geminiClient = new GoogleGenAI({ apiKey });
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

async function tryGenerateSeverityHint({ serviceName, severity, message }) {
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
      model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      contents: prompt,
      config: { temperature: 0 }
    });

    const text = (response.text || "").trim().toUpperCase();
    const match = text.match(/\b(LOW|MEDIUM|HIGH|CRITICAL)\b/);
    const hint = match ? match[1] : null;

    console.log(
      `Severity hint for ${serviceName || "?"}: ${hint || "unparseable"} (${Date.now() - startedAt}ms)`
    );
    return hint;
  } catch (error) {
    console.error(
      `Severity hint skipped for service=${serviceName}:`,
      error.message
    );
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

async function enrichIncidentEvent(event) {
  if (event.type !== "INCIDENT_REPORTED") {
    return;
  }

  if (typeof event.message === "string" && event.message.includes("BREAK_ENRICH")) {
    throw new Error("Forced enrichment failure for DLQ test");
  }

  const wasMarked = await markMessageProcessed(CONSUMER_GROUP, event.id);
  if (!wasMarked) {
    console.log(`Skipping duplicate event ${event.id} in enrichment group`);
    return;
  }

  const teamId = lookupTeamId(event.serviceName);
  const severityBucket = normalizeSeverityBucket(event.severity);
  const aiSeverityHint = await tryGenerateSeverityHint({
    serviceName: event.serviceName,
    severity: event.severity,
    message: event.message
  });

  const enriched = buildEnrichedEvent({
    source: event,
    teamId,
    severityBucket,
    aiSeverityHint
  });

  await publishIncidentEnriched(enriched);

  console.log(
    `Enriched incidentId=${event.incidentId} team=${teamId} bucket=${severityBucket} hint=${aiSeverityHint || "none"}`
  );
}

async function processWithRetry(event, kafkaMetadata) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await enrichIncidentEvent(event);

      console.log(
        `Enrichment processed event ${event.id} on attempt ${attempt}`
      );

      return;
    } catch (error) {
      lastError = error;

      console.error(
        `Enrichment attempt ${attempt}/${MAX_RETRIES} failed for incidentId=${event.incidentId}:`,
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
    failedConsumerGroup: CONSUMER_GROUP,
    originalTopic: kafkaMetadata.topic,
    originalPartition: kafkaMetadata.partition,
    originalOffset: kafkaMetadata.offset,
    originalMessage: event
  };

  await publishToDlq(dlqPayload);

  console.error(
    `Enrichment moved event ${event.id} to DLQ after ${MAX_RETRIES} attempts`
  );
}

async function startConsumer() {
  await connectCassandra();
  await consumer.connect();

  await consumer.subscribe({
    topic: "incident-events",
    fromBeginning: true
  });

  console.log("Kafka enrichment consumer is running...");

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const rawValue = message.value.toString();
        const event = JSON.parse(rawValue);

        console.log(
          `Enrichment received message ${topic}[${partition}] offset=${message.offset} eventId=${event.id} type=${event.type}`
        );

        await processWithRetry(event, {
          topic,
          partition,
          offset: message.offset
        });
      } catch (error) {
        console.error("Enrichment failed to process Kafka message:", error);

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
          console.error(
            `Enrichment moved malformed message at offset ${message.offset} to DLQ`
          );
        } catch (dlqError) {
          console.error("Enrichment failed to publish malformed message to DLQ:", dlqError);
          throw dlqError;
        }
      }
    }
  });
}

startConsumer().catch((error) => {
  console.error("Enrichment consumer failed to start:", error);
});
