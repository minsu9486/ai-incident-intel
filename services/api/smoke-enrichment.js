/**
 * smoke-enrichment: end-to-end smoke for the enrichment consumer + downstream
 * team/severity projections.
 *
 * Posts an incident on a known service (payments-api → team "payments"), polls
 * GraphQL incidentsByTeam and incidentsBySeverity until the projections land,
 * then exercises the FORCE_DLQ_ENRICH path: a second incident is posted whose
 * enrichment will fail 3x and DLQ. The original INCIDENT_REPORTED projection
 * (incidentTimeline) must still land — that's the load-bearing claim that the
 * two consumer groups are independent.
 *
 * Requires: Docker stack up, schema applied, and three processes running:
 *   npm start
 *   npm run consumer
 *   npm run enrichment-consumer
 *
 * Run: npm run smoke-enrichment
 */
require("dotenv").config();

const { Kafka } = require("kafkajs");
const { getGlobalDispatcher } = require("undici");

const API_BASE = "http://localhost:4000";
const KAFKA_BROKERS = ["localhost:9092"];
const POLL_INTERVAL_MS = 750;
const POLL_TIMEOUT_MS = 30000;
const DLQ_WAIT_MS = 8000;

const RUN_TAG = `smoke-enrich-${Date.now()}`;

const GOOD_INCIDENT = {
  incidentId: `${RUN_TAG}-good`,
  orgId: "smoke-org",
  serviceName: "payments-api",
  severity: "CRITICAL",
  message:
    "Payments API timing out after deployment, error rate at 22%, p99 latency 6.1s."
};

const FORCE_DLQ_INCIDENT = {
  incidentId: `${RUN_TAG}-bad`,
  orgId: "smoke-org",
  serviceName: "payments-api",
  severity: "HIGH",
  message:
    "Payments dependency timing out — BREAK_ENRICH (this should fail enrichment but the original projection must still land)."
};

const EXPECTED_TEAM = "payments";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayDayBucket() {
  return new Date().toISOString().slice(0, 10);
}

async function checkHealth() {
  let res;
  try {
    res = await fetch(`${API_BASE}/health`);
  } catch (err) {
    fail(`API not reachable at ${API_BASE} (${err.code || err.message}). Is 'npm start' running?`);
  }
  if (!res.ok) fail(`/health returned ${res.status}`);
}

async function postIncident(seed) {
  const res = await fetch(`${API_BASE}/incidents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(seed)
  });
  if (!res.ok) {
    const text = await res.text();
    fail(`POST /incidents returned ${res.status}: ${text}`);
  }
}

async function gqlQuery(query, variables) {
  const res = await fetch(`${API_BASE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${JSON.stringify(body)}`);
  if (body.errors && body.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

async function fetchByTeam(teamId, limit = 50) {
  const data = await gqlQuery(
    `query ($teamId: String!, $limit: Int!) {
      incidentsByTeam(teamId: $teamId, limit: $limit) {
        incidentId orgId serviceName teamId severity severityBucket message reportedAt
      }
    }`,
    { teamId, limit }
  );
  return data.incidentsByTeam;
}

async function fetchBySeverity(severityBucket, day, limit = 50) {
  const data = await gqlQuery(
    `query ($sev: String!, $day: String!, $limit: Int!) {
      incidentsBySeverity(severityBucket: $sev, day: $day, limit: $limit) {
        incidentId orgId serviceName teamId severityBucket message reportedAt
      }
    }`,
    { sev: severityBucket, day, limit }
  );
  return data.incidentsBySeverity;
}

async function fetchTimeline(incidentId) {
  const data = await gqlQuery(
    `query ($id: ID!) {
      incidentTimeline(incidentId: $id) {
        id incidentId type message timestamp
      }
    }`,
    { id: incidentId }
  );
  return data.incidentTimeline;
}

async function waitForTeamProjection(incidentId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await fetchByTeam(EXPECTED_TEAM, 50);
    const hit = rows.find((r) => r.incidentId === incidentId);
    if (hit) return hit;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(
    `incidentsByTeam did not contain ${incidentId} within ${POLL_TIMEOUT_MS}ms. ` +
      "Are 'npm run consumer' and 'npm run enrichment-consumer' both running?"
  );
}

async function waitForSeverityProjection(incidentId, severityBucket) {
  const day = todayDayBucket();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await fetchBySeverity(severityBucket, day, 50);
    const hit = rows.find((r) => r.incidentId === incidentId);
    if (hit) return hit;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(
    `incidentsBySeverity(${severityBucket}, ${day}) did not contain ${incidentId} within ${POLL_TIMEOUT_MS}ms.`
  );
}

async function waitForTimeline(incidentId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await fetchTimeline(incidentId);
    if (rows.length > 0) return rows;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(`incidentTimeline did not return events for ${incidentId} within ${POLL_TIMEOUT_MS}ms.`);
}

async function readDlqUntil(matchPredicate, timeoutMs) {
  const kafka = new Kafka({
    clientId: `smoke-enrichment-${Date.now()}`,
    brokers: KAFKA_BROKERS
  });
  const dlqConsumer = kafka.consumer({
    groupId: `smoke-enrichment-dlq-${Date.now()}`
  });

  let found = null;
  await dlqConsumer.connect();
  await dlqConsumer.subscribe({ topic: "incident-events-dlq", fromBeginning: true });

  const stopAt = Date.now() + timeoutMs;
  await dlqConsumer.run({
    eachMessage: async ({ message }) => {
      if (found) return;
      try {
        const payload = JSON.parse(message.value.toString());
        if (matchPredicate(payload)) {
          found = payload;
        }
      } catch (_e) {}
    }
  });

  while (!found && Date.now() < stopAt) {
    await sleep(POLL_INTERVAL_MS);
  }

  await dlqConsumer.disconnect();
  return found;
}

async function main() {
  console.log("smoke-enrichment: enrichment consumer + team/severity projections");
  console.log(`run tag: ${RUN_TAG}`);
  console.log("");

  console.log("step 1: GET /health");
  await checkHealth();
  console.log("  ok");

  console.log(`step 2: POST /incidents (golden path, ${GOOD_INCIDENT.incidentId})`);
  await postIncident(GOOD_INCIDENT);
  console.log("  ok");

  console.log("step 3: poll incidentsByTeam until enrichment + projection land");
  const teamRow = await waitForTeamProjection(GOOD_INCIDENT.incidentId);
  if (teamRow.teamId !== EXPECTED_TEAM) {
    fail(`expected teamId=${EXPECTED_TEAM}, got ${teamRow.teamId}`);
  }
  if (teamRow.severityBucket !== "CRITICAL") {
    fail(`expected severityBucket=CRITICAL, got ${teamRow.severityBucket}`);
  }
  console.log(`  PASS: team=${teamRow.teamId}, bucket=${teamRow.severityBucket}`);

  console.log("step 4: poll incidentsBySeverity for same incident");
  const sevRow = await waitForSeverityProjection(GOOD_INCIDENT.incidentId, "CRITICAL");
  if (sevRow.teamId !== EXPECTED_TEAM) {
    fail(`severity projection: expected teamId=${EXPECTED_TEAM}, got ${sevRow.teamId}`);
  }
  console.log(`  PASS: severity row reportedAt=${sevRow.reportedAt}`);

  console.log(`step 5: POST /incidents (force-DLQ path, ${FORCE_DLQ_INCIDENT.incidentId})`);
  await postIncident(FORCE_DLQ_INCIDENT);
  console.log("  ok");

  console.log("step 6: confirm INCIDENT_REPORTED projection still lands (consumer groups are independent)");
  const timelineRows = await waitForTimeline(FORCE_DLQ_INCIDENT.incidentId);
  if (timelineRows.length === 0) {
    fail("expected at least one timeline event for force-DLQ incident; projection consumer is supposed to be unaffected by enrichment failures");
  }
  console.log(`  PASS: timeline has ${timelineRows.length} event(s) for the force-DLQ incident`);

  console.log(`step 7: confirm enrichment failure landed in incident-events-dlq (waiting up to ${DLQ_WAIT_MS}ms)`);
  const dlqMatch = await readDlqUntil(
    (payload) =>
      payload &&
      payload.incidentId === FORCE_DLQ_INCIDENT.incidentId &&
      payload.failedConsumerGroup === "incident-enrichment-group",
    DLQ_WAIT_MS
  );
  if (!dlqMatch) {
    fail(
      `did not find a DLQ entry tagged failedConsumerGroup=incident-enrichment-group for ${FORCE_DLQ_INCIDENT.incidentId}. ` +
        "Is 'npm run enrichment-consumer' running?"
    );
  }
  console.log(`  PASS: DLQ entry retryCount=${dlqMatch.retryCount} errorMessage='${dlqMatch.errorMessage}'`);

  console.log("step 8: confirm force-DLQ incident did NOT land in incidentsByTeam (enrichment never published it)");
  const allTeam = await fetchByTeam(EXPECTED_TEAM, 100);
  const leaked = allTeam.find((r) => r.incidentId === FORCE_DLQ_INCIDENT.incidentId);
  if (leaked) {
    fail(`force-DLQ incident leaked into incidents_by_team: ${JSON.stringify(leaked)}`);
  }
  console.log("  PASS: no leakage");

  console.log("");
  console.log("all checks passed");

  await getGlobalDispatcher().close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
