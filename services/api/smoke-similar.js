/**
 * smoke-similar: end-to-end smoke for similar-incident retrieval.
 * Seeds 3 incidents (2 payments-api, 1 auth-service), polls until all are
 * indexed in incident_embeddings, then asserts that POST /ai/similar-incidents
 * and GraphQL similarIncidents both rank the payments incidents above the auth
 * incident and filter out the self-match.
 *
 * Requires: Docker stack up, `npm start`, and `npm run consumer` running;
 *           GEMINI_API_KEY set in the smoke process, API, and consumer.
 * Run:      npm run smoke-similar
 */
require("dotenv").config();

const { getGlobalDispatcher } = require("undici");

const API_BASE = "http://localhost:4000";
const POLL_INTERVAL_MS = 750;
const POLL_TIMEOUT_MS = 30000;

const RUN_TAG = `smoke-sim-${Date.now()}`;
const SEEDS = [
  {
    incidentId: `${RUN_TAG}-pay-1`,
    orgId: "smoke-org",
    serviceName: "payments-api",
    severity: "CRITICAL",
    message:
      "Payments API timing out after deployment. Error rate increased to 18% and p95 latency exceeded 4.2s. Repeated timeouts to postgres-primary."
  },
  {
    incidentId: `${RUN_TAG}-pay-2`,
    orgId: "smoke-org",
    serviceName: "payments-api",
    severity: "HIGH",
    message:
      "Database connection timeouts on payments service. Connection pool exhausted, p99 spiked to 9.4s, 5xx rate at 41%."
  },
  {
    incidentId: `${RUN_TAG}-auth-1`,
    orgId: "smoke-org",
    serviceName: "auth-service",
    severity: "LOW",
    message:
      "Slow logins after secret rotation. Cache hit rate dropped from 97% to 64% on auth-service after a credential rotation deploy."
  }
];

const QUERY_INCIDENT = {
  incidentId: `${RUN_TAG}-query`,
  orgId: "smoke-org",
  serviceName: "payments-api",
  severity: "CRITICAL",
  message: "Payment timeouts spiking after release; postgres connection errors observed."
};

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

async function callSimilarRest(query, k = 5) {
  const res = await fetch(`${API_BASE}/ai/similar-incidents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...query, k })
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`POST /ai/similar-incidents ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function callSimilarGraphql(query, k = 5) {
  const res = await fetch(`${API_BASE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query ($id: ID!, $org: ID, $svc: String, $sev: String, $msg: String!, $k: Int!) {
        similarIncidents(incidentId: $id, orgId: $org, serviceName: $svc, severity: $sev, message: $msg, k: $k) {
          incidentId orgId serviceName severity message score
        }
      }`,
      variables: {
        id: query.incidentId,
        org: query.orgId,
        svc: query.serviceName,
        sev: query.severity,
        msg: query.message,
        k
      }
    })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${JSON.stringify(body)}`);
  if (body.errors && body.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data.similarIncidents;
}

async function waitUntilAllSeedsIndexed() {
  const expected = new Set(SEEDS.map((s) => s.incidentId));
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastSeen = new Set();
  while (Date.now() < deadline) {
    const body = await callSimilarRest(QUERY_INCIDENT, 50);
    lastSeen = new Set(body.matches.map((m) => m.incidentId));
    const missing = [...expected].filter((id) => !lastSeen.has(id));
    if (missing.length === 0) return;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(
    `not all seeded incidents were indexed within ${POLL_TIMEOUT_MS}ms. ` +
      `Saw: [${[...lastSeen].join(", ")}]. ` +
      "Is 'npm run consumer' running with GEMINI_API_KEY set?"
  );
}

function validateMatchShape(match, label) {
  const errors = [];
  for (const f of ["incidentId", "message", "score"]) {
    if (!(f in match)) errors.push(`${label}: missing field ${f}`);
  }
  if (errors.length > 0) return errors;
  if (typeof match.score !== "number" || Number.isNaN(match.score)) {
    errors.push(`${label}: score must be a number, got ${JSON.stringify(match.score)}`);
  }
  if (typeof match.score === "number" && (match.score < -1.01 || match.score > 1.01)) {
    errors.push(`${label}: cosine score should be in [-1, 1], got ${match.score}`);
  }
  return errors;
}

function assertRanking(matches, label) {
  const byId = new Map(matches.map((m) => [m.incidentId, m]));
  const errors = [];

  for (const seed of SEEDS) {
    if (!byId.has(seed.incidentId)) {
      errors.push(`${label}: missing seeded incident ${seed.incidentId} from results`);
    }
  }
  if (errors.length > 0) return errors;

  const pay1 = byId.get(`${RUN_TAG}-pay-1`).score;
  const pay2 = byId.get(`${RUN_TAG}-pay-2`).score;
  const auth1 = byId.get(`${RUN_TAG}-auth-1`).score;
  const minPay = Math.min(pay1, pay2);

  if (auth1 >= minPay) {
    errors.push(
      `${label}: auth-service incident scored ${auth1.toFixed(4)}, ` +
        `not lower than payments incidents (${pay1.toFixed(4)}, ${pay2.toFixed(4)}). ` +
        "Retrieval should rank same-service-and-failure-mode incidents higher."
    );
  }

  if (matches.some((m) => m.incidentId === QUERY_INCIDENT.incidentId)) {
    errors.push(`${label}: query incident ${QUERY_INCIDENT.incidentId} should be filtered out (self-match)`);
  }

  return errors;
}

async function main() {
  console.log("smoke-similar: similar-incident retrieval (Docker stack + npm start + npm run consumer must be running)");
  console.log("");

  if (!process.env.GEMINI_API_KEY) {
    fail(
      "GEMINI_API_KEY is not set in the smoke-test process. " +
        "Both API and consumer also need it; ensure services/api/.env is loaded before 'npm start' / 'npm run consumer'."
    );
  }

  console.log(`run tag: ${RUN_TAG}`);
  console.log(`seeds:   ${SEEDS.map((s) => s.incidentId).join(", ")}`);
  console.log(`query:   ${QUERY_INCIDENT.incidentId}`);
  console.log("");

  console.log("step 1: GET /health");
  await checkHealth();
  console.log("  ok");

  console.log("step 2: POST /incidents x3 (2 payments, 1 auth)");
  for (const seed of SEEDS) await postIncident(seed);
  console.log("  ok");

  console.log("step 3: poll /ai/similar-incidents until all 3 seeds appear (covers projection + embedding)");
  await waitUntilAllSeedsIndexed();
  console.log("  ok");

  console.log("step 4: REST /ai/similar-incidents — payments-api query");
  const restStart = Date.now();
  const restBody = await callSimilarRest(QUERY_INCIDENT, 5);
  const restMs = Date.now() - restStart;
  if (!Array.isArray(restBody.matches) || restBody.matches.length === 0) {
    fail(`REST: matches array missing or empty. body=${JSON.stringify(restBody)}`);
  }
  const restShapeErrors = restBody.matches.flatMap((m, i) => validateMatchShape(m, `REST match[${i}]`));
  const restRankErrors = assertRanking(restBody.matches, "REST");
  const restErrors = [...restShapeErrors, ...restRankErrors];
  if (restErrors.length > 0) {
    console.error("REST validation failed:");
    for (const e of restErrors) console.error(`  - ${e}`);
    console.error("");
    console.error("raw REST response:");
    console.error(JSON.stringify(restBody, null, 2));
    process.exit(1);
  }
  console.log(`  PASS: REST returned ${restBody.matches.length} matches; payments scored above auth (${restMs}ms)`);

  console.log("step 5: GraphQL similarIncidents — payments-api query");
  const gqlStart = Date.now();
  const gqlMatches = await callSimilarGraphql(QUERY_INCIDENT, 5);
  const gqlMs = Date.now() - gqlStart;
  if (!Array.isArray(gqlMatches) || gqlMatches.length === 0) {
    fail(`GraphQL: similarIncidents array missing or empty. data=${JSON.stringify(gqlMatches)}`);
  }
  const gqlShapeErrors = gqlMatches.flatMap((m, i) => validateMatchShape(m, `GraphQL match[${i}]`));
  const gqlRankErrors = assertRanking(gqlMatches, "GraphQL");
  const gqlErrors = [...gqlShapeErrors, ...gqlRankErrors];
  if (gqlErrors.length > 0) {
    console.error("GraphQL validation failed:");
    for (const e of gqlErrors) console.error(`  - ${e}`);
    console.error("");
    console.error("raw GraphQL response:");
    console.error(JSON.stringify(gqlMatches, null, 2));
    process.exit(1);
  }
  console.log(`  PASS: GraphQL returned ${gqlMatches.length} matches; payments scored above auth (${gqlMs}ms)`);

  console.log("step 6: input-validation guards");
  const badRest = await fetch(`${API_BASE}/ai/similar-incidents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incidentId: "x" })
  });
  if (badRest.status !== 400) {
    fail(`REST: expected 400 for missing message, got ${badRest.status}`);
  }
  console.log("  ok (missing 'message' returns 400)");

  console.log("");
  console.log("REST response:");
  console.log(JSON.stringify(restBody, null, 2));
  console.log("");
  console.log("GraphQL response:");
  console.log(JSON.stringify(gqlMatches, null, 2));

  await getGlobalDispatcher().close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
