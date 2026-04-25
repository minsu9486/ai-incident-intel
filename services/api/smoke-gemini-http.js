require("dotenv").config();

const API_BASE = "http://localhost:4000";
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 15000;

const VALID_CONFIDENCE = ["LOW", "MEDIUM", "HIGH"];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkHealth() {
  let res;
  try {
    res = await fetch(`${API_BASE}/health`);
  } catch (err) {
    fail(`API not reachable at ${API_BASE} (${err.code || err.message}). Is 'npm start' running?`);
  }
  if (!res.ok) fail(`/health returned ${res.status}`);
  const body = await res.json();
  if (!body.ok) fail(`/health body did not contain ok=true: ${JSON.stringify(body)}`);
}

async function createIncident({ incidentId, orgId }) {
  const payload = {
    incidentId,
    orgId,
    serviceName: "checkout-service",
    severity: "HIGH",
    message:
      "Database connection pool exhausted on primary checkout-db. " +
      "Checkout API p99 latency spiked from 180ms to 9.4s and 5xx rate hit 41%. " +
      "Postgres logs report 'remaining connection slots reserved for non-replication superuser connections'."
  };

  const res = await fetch(`${API_BASE}/incidents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    fail(`POST /incidents returned ${res.status}: ${text}`);
  }
  return res.json();
}

async function graphql(query, variables) {
  const res = await fetch(`${API_BASE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
  }
  const body = await res.json();
  if (body.errors && body.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

async function waitForProjection(incidentId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const data = await graphql(
      `query ($id: ID!) { incidentTimeline(incidentId: $id) { id type } }`,
      { id: incidentId }
    );
    lastCount = data.incidentTimeline.length;
    if (lastCount > 0) return lastCount;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(
    `incident ${incidentId} never appeared in incidentTimeline after ${POLL_TIMEOUT_MS}ms — ` +
      "is 'npm run consumer' running?"
  );
}

function validateRestShape(out) {
  const errors = [];
  for (const f of [
    "ok",
    "incidentId",
    "summary",
    "customer_impact",
    "likely_root_cause",
    "confidence",
    "next_actions",
    "signals"
  ]) {
    if (!(f in out)) errors.push(`missing field: ${f}`);
  }
  if (errors.length > 0) return errors;
  if (out.ok !== true) errors.push(`ok must be true, got ${JSON.stringify(out.ok)}`);
  if (typeof out.summary !== "string" || out.summary.trim() === "") errors.push("summary must be a non-empty string");
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

function validateGraphqlShape(out) {
  const errors = [];
  for (const f of [
    "incidentId",
    "summary",
    "customerImpact",
    "likelyRootCause",
    "confidence",
    "nextActions",
    "signals"
  ]) {
    if (!(f in out)) errors.push(`missing field: ${f}`);
  }
  if (errors.length > 0) return errors;
  if (typeof out.summary !== "string" || out.summary.trim() === "") errors.push("summary must be a non-empty string");
  if (!VALID_CONFIDENCE.includes(out.confidence)) {
    errors.push(`confidence must be one of ${VALID_CONFIDENCE.join("|")}, got ${JSON.stringify(out.confidence)}`);
  }
  if (!Array.isArray(out.nextActions) || out.nextActions.length !== 3) {
    errors.push(`nextActions must be an array of length 3, got length ${out.nextActions?.length}`);
  }
  if (!Array.isArray(out.signals) || out.signals.length !== 3) {
    errors.push(`signals must be an array of length 3, got length ${out.signals?.length}`);
  }
  return errors;
}

async function callRest(incidentId, orgId) {
  const res = await fetch(`${API_BASE}/ai/incident-summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incidentId, orgId, limit: 20 })
  });
  const body = await res.json();
  if (!res.ok) {
    fail(`POST /ai/incident-summary returned ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function callGraphql(incidentId, orgId) {
  return (
    await graphql(
      `query ($id: ID!, $org: ID) {
        incidentSummary(incidentId: $id, orgId: $org) {
          incidentId summary customerImpact likelyRootCause confidence nextActions signals
        }
      }`,
      { id: incidentId, org: orgId }
    )
  ).incidentSummary;
}

async function main() {
  console.log("smoke-gemini-http: full HTTP path (Docker stack + npm start + npm run consumer must be running)");
  console.log("");

  if (!process.env.GEMINI_API_KEY) {
    fail("GEMINI_API_KEY is not set in the API process. Make sure services/api/.env has it before 'npm start'.");
  }

  const incidentId = `smoke-test-${Date.now()}`;
  const orgId = "smoke-org";
  console.log(`incidentId: ${incidentId}`);
  console.log(`orgId: ${orgId}`);
  console.log("");

  console.log("step 1: GET /health");
  await checkHealth();
  console.log("  ok");

  console.log("step 2: POST /incidents");
  await createIncident({ incidentId, orgId });
  console.log("  ok");

  console.log("step 3: poll incidentTimeline until consumer projects the event");
  const eventCount = await waitForProjection(incidentId);
  console.log(`  ok (${eventCount} event${eventCount === 1 ? "" : "s"} visible)`);

  console.log("step 4: POST /ai/incident-summary");
  const restStart = Date.now();
  const restOut = await callRest(incidentId, orgId);
  const restMs = Date.now() - restStart;
  const restErrors = validateRestShape(restOut);
  if (restErrors.length > 0) {
    console.error("REST response validation failed:");
    for (const e of restErrors) console.error(`  - ${e}`);
    console.error("");
    console.error("raw REST response:");
    console.error(JSON.stringify(restOut, null, 2));
    process.exit(1);
  }
  console.log(`  PASS: REST shape valid (${restMs}ms)`);

  console.log("step 5: GraphQL incidentSummary query");
  const gqlStart = Date.now();
  const gqlOut = await callGraphql(incidentId, orgId);
  const gqlMs = Date.now() - gqlStart;
  const gqlErrors = validateGraphqlShape(gqlOut);
  if (gqlErrors.length > 0) {
    console.error("GraphQL response validation failed:");
    for (const e of gqlErrors) console.error(`  - ${e}`);
    console.error("");
    console.error("raw GraphQL response:");
    console.error(JSON.stringify(gqlOut, null, 2));
    process.exit(1);
  }
  console.log(`  PASS: GraphQL shape valid (${gqlMs}ms)`);

  console.log("");
  console.log("REST response:");
  console.log(JSON.stringify(restOut, null, 2));
  console.log("");
  console.log("GraphQL response:");
  console.log(JSON.stringify(gqlOut, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
