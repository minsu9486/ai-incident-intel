require("dotenv").config();

const { generateIncidentSummary } = require("./gemini");
const { getGlobalDispatcher } = require("undici");

const REQUIRED_FIELDS = [
  "summary",
  "customer_impact",
  "likely_root_cause",
  "confidence",
  "next_actions",
  "signals"
];

const VALID_CONFIDENCE = ["LOW", "MEDIUM", "HIGH"];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function buildSyntheticInput() {
  const incidentId = "smoke-incident-001";
  const orgId = "smoke-org";
  const baseTime = Date.parse("2026-04-24T15:30:00Z");
  const minute = 60 * 1000;

  const events = [
    {
      id: "evt-4",
      incidentId,
      type: "INCIDENT_NOTE",
      message: "On-call increased pgbouncer pool size from 50 to 200 and error rate returned to baseline.",
      timestamp: new Date(baseTime + 4 * minute).toISOString()
    },
    {
      id: "evt-3",
      incidentId,
      type: "INCIDENT_UPDATE",
      message: "Checkout API p99 latency spiked from 180ms to 9.4s; 5xx rate hit 41%.",
      timestamp: new Date(baseTime + 2 * minute).toISOString()
    },
    {
      id: "evt-2",
      incidentId,
      type: "INCIDENT_UPDATE",
      message: "Postgres logs: 'remaining connection slots reserved for non-replication superuser connections'.",
      timestamp: new Date(baseTime + 1 * minute).toISOString()
    },
    {
      id: "evt-1",
      incidentId,
      type: "INCIDENT_REPORTED",
      message: "Database connection pool exhausted on primary checkout-db; checkout-service returning 503s.",
      timestamp: new Date(baseTime).toISOString()
    }
  ];

  const serviceHealth = [
    {
      orgId,
      serviceName: "checkout-service",
      latestIncidentId: incidentId,
      latestEventId: "evt-3",
      severity: "HIGH",
      status: "DEGRADED",
      lastUpdated: new Date(baseTime + 2 * minute).toISOString(),
      message: "5xx rate 41%, p99 9.4s"
    },
    {
      orgId,
      serviceName: "checkout-db",
      latestIncidentId: incidentId,
      latestEventId: "evt-2",
      severity: "HIGH",
      status: "DEGRADED",
      lastUpdated: new Date(baseTime + 1 * minute).toISOString(),
      message: "Connection pool exhausted"
    }
  ];

  return { incidentId, orgId, events, serviceHealth };
}

function validateResponse(out) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in out)) errors.push(`missing field: ${field}`);
  }
  if (errors.length > 0) return errors;

  if (typeof out.summary !== "string" || out.summary.trim() === "") {
    errors.push("summary must be a non-empty string");
  }
  if (typeof out.customer_impact !== "string" || out.customer_impact.trim() === "") {
    errors.push("customer_impact must be a non-empty string");
  }
  if (typeof out.likely_root_cause !== "string" || out.likely_root_cause.trim() === "") {
    errors.push("likely_root_cause must be a non-empty string");
  }
  if (!VALID_CONFIDENCE.includes(out.confidence)) {
    errors.push(`confidence must be one of ${VALID_CONFIDENCE.join("|")}, got ${JSON.stringify(out.confidence)}`);
  }
  if (!Array.isArray(out.next_actions) || out.next_actions.length !== 3) {
    errors.push(`next_actions must be an array of length 3, got length ${out.next_actions?.length}`);
  }
  if (!Array.isArray(out.signals) || out.signals.length !== 3) {
    errors.push(`signals must be an array of length 3, got length ${out.signals?.length}`);
  }

  return errors;
}

async function main() {
  console.log("smoke-gemini: tests generateIncidentSummary() in isolation (no Kafka/Cassandra/API needed)");
  console.log("");

  if (!process.env.GEMINI_API_KEY) {
    fail("GEMINI_API_KEY is not set. Add it to services/api/.env or export it before running.");
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash (default)";
  console.log(`model: ${model}`);

  const input = buildSyntheticInput();
  console.log(`incidentId: ${input.incidentId}`);
  console.log(`events: ${input.events.length}, serviceHealth rows: ${input.serviceHealth.length}`);
  console.log("");

  const startedAt = Date.now();
  let out;
  try {
    out = await generateIncidentSummary(input);
  } catch (err) {
    console.error(`gemini call threw after ${Date.now() - startedAt}ms`);
    fail(err.message || String(err));
  }
  const elapsedMs = Date.now() - startedAt;

  const errors = validateResponse(out);
  if (errors.length > 0) {
    console.error("response validation failed:");
    for (const e of errors) console.error(`  - ${e}`);
    console.error("");
    console.error("raw response:");
    console.error(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  console.log(`PASS: shape valid (${elapsedMs}ms)`);
  console.log("");
  console.log("response:");
  console.log(JSON.stringify(out, null, 2));
  await getGlobalDispatcher().close();
  process.exit(0);
}

main();
