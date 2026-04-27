require("dotenv").config();

const { getGlobalDispatcher } = require("undici");

const API_BASE = "http://localhost:4000";
const POLL_INTERVAL_MS = 750;
const POLL_TIMEOUT_MS = 30000;

const RUN_TAG = `smoke-rec-${Date.now()}`;
const SEED = {
  incidentId: `${RUN_TAG}-pay-1`,
  orgId: "smoke-org",
  serviceName: "payments-api",
  severity: "CRITICAL",
  message:
    "Payments API timing out after deployment. Error rate increased to 18% and p95 latency exceeded 4.2s. Repeated timeouts to postgres-primary."
};

const VALID_ENUM = new Set(["LOW", "MEDIUM", "HIGH"]);

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

async function waitUntilSeedIndexed() {
  const probeQuery = {
    incidentId: `${RUN_TAG}-probe`,
    orgId: SEED.orgId,
    serviceName: SEED.serviceName,
    severity: SEED.severity,
    message: SEED.message
  };
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastSeen = new Set();
  while (Date.now() < deadline) {
    const body = await callSimilarRest(probeQuery, 50);
    lastSeen = new Set(body.matches.map((m) => m.incidentId));
    if (lastSeen.has(SEED.incidentId)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(
    `seeded incident ${SEED.incidentId} was not indexed within ${POLL_TIMEOUT_MS}ms. ` +
      `Saw: [${[...lastSeen].join(", ")}]. ` +
      "Is 'npm run consumer' running with GEMINI_API_KEY set?"
  );
}

async function callRecommendedRest(incidentId, k = 3) {
  const res = await fetch(`${API_BASE}/ai/recommended-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incidentId, k })
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`POST /ai/recommended-actions ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function callRecommendedGraphql(incidentId, k = 3) {
  const res = await fetch(`${API_BASE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query ($id: ID!, $k: Int!) {
        recommendedActions(incidentId: $id, k: $k) {
          incidentId
          actions { priority action reason confidence risk }
          notes
        }
      }`,
      variables: { id: incidentId, k }
    })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${JSON.stringify(body)}`);
  if (body.errors && body.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data.recommendedActions;
}

function validateActions(actions, label) {
  const errors = [];

  if (!Array.isArray(actions)) {
    errors.push(`${label}: actions is not an array`);
    return errors;
  }
  if (actions.length !== 3) {
    errors.push(`${label}: expected exactly 3 actions, got ${actions.length}`);
  }

  const expectedFields = ["priority", "action", "reason", "confidence", "risk"];
  actions.forEach((a, i) => {
    for (const f of expectedFields) {
      if (!(f in a)) errors.push(`${label}.actions[${i}]: missing field ${f}`);
    }
    if (typeof a.priority !== "number") {
      errors.push(`${label}.actions[${i}]: priority must be a number, got ${typeof a.priority}`);
    }
    if (typeof a.action !== "string" || a.action.trim().length === 0) {
      errors.push(`${label}.actions[${i}]: action must be a non-empty string`);
    }
    if (typeof a.reason !== "string" || a.reason.trim().length === 0) {
      errors.push(`${label}.actions[${i}]: reason must be a non-empty string`);
    }
    if (!VALID_ENUM.has(a.confidence)) {
      errors.push(`${label}.actions[${i}]: confidence ${JSON.stringify(a.confidence)} not in {LOW,MEDIUM,HIGH}`);
    }
    if (!VALID_ENUM.has(a.risk)) {
      errors.push(`${label}.actions[${i}]: risk ${JSON.stringify(a.risk)} not in {LOW,MEDIUM,HIGH}`);
    }
  });

  const priorities = actions.map((a) => a.priority);
  for (let i = 1; i < priorities.length; i += 1) {
    if (priorities[i] < priorities[i - 1]) {
      errors.push(`${label}: actions not sorted by priority ascending: ${priorities.join(",")}`);
      break;
    }
  }

  return errors;
}

async function main() {
  console.log("smoke-recommended: recommended-actions RAG (Docker stack + npm start + npm run consumer + npm run index-runbooks must be done)");
  console.log("");

  if (!process.env.GEMINI_API_KEY) {
    fail(
      "GEMINI_API_KEY is not set in the smoke-test process. " +
        "Both API and consumer also need it; ensure services/api/.env is loaded."
    );
  }

  console.log(`run tag: ${RUN_TAG}`);
  console.log(`seed:    ${SEED.incidentId}`);
  console.log("");

  console.log("step 1: GET /health");
  await checkHealth();
  console.log("  ok");

  console.log("step 2: POST /incidents");
  await postIncident(SEED);
  console.log("  ok");

  console.log("step 3: poll /ai/similar-incidents until seed appears (covers projection + embedding)");
  await waitUntilSeedIndexed();
  console.log("  ok");

  console.log("step 4: REST /ai/recommended-actions");
  const restStart = Date.now();
  const restBody = await callRecommendedRest(SEED.incidentId, 3);
  const restMs = Date.now() - restStart;
  if (!restBody.recommendations) {
    fail(`REST: missing 'recommendations' field. body=${JSON.stringify(restBody)}`);
  }
  const restErrors = validateActions(restBody.recommendations.actions, "REST");
  if (typeof restBody.recommendations.notes !== "string" || restBody.recommendations.notes.trim().length === 0) {
    restErrors.push("REST: notes must be a non-empty string");
  }
  if (restErrors.length > 0) {
    console.error("REST validation failed:");
    for (const e of restErrors) console.error(`  - ${e}`);
    console.error("");
    console.error("raw REST response:");
    console.error(JSON.stringify(restBody, null, 2));
    process.exit(1);
  }
  const runbookCount = restBody.retrieved && restBody.retrieved.runbooks ? restBody.retrieved.runbooks.length : 0;
  const similarCount = restBody.retrieved && restBody.retrieved.similarIncidents ? restBody.retrieved.similarIncidents.length : 0;
  console.log(`  PASS: REST returned 3 actions; retrieved ${runbookCount} runbooks + ${similarCount} similar incidents (${restMs}ms)`);
  if (runbookCount === 0) {
    console.warn("  WARN: 0 runbooks retrieved. Did you run 'npm run index-runbooks' first?");
  }

  console.log("step 5: GraphQL recommendedActions");
  const gqlStart = Date.now();
  const gqlOut = await callRecommendedGraphql(SEED.incidentId, 3);
  const gqlMs = Date.now() - gqlStart;
  const gqlErrors = validateActions(gqlOut.actions, "GraphQL");
  if (typeof gqlOut.notes !== "string" || gqlOut.notes.trim().length === 0) {
    gqlErrors.push("GraphQL: notes must be a non-empty string");
  }
  if (gqlOut.incidentId !== SEED.incidentId) {
    gqlErrors.push(`GraphQL: incidentId mismatch (expected ${SEED.incidentId}, got ${gqlOut.incidentId})`);
  }
  if (gqlErrors.length > 0) {
    console.error("GraphQL validation failed:");
    for (const e of gqlErrors) console.error(`  - ${e}`);
    console.error("");
    console.error("raw GraphQL response:");
    console.error(JSON.stringify(gqlOut, null, 2));
    process.exit(1);
  }
  console.log(`  PASS: GraphQL returned 3 actions (${gqlMs}ms)`);

  console.log("step 6: input-validation guards");
  const badRest = await fetch(`${API_BASE}/ai/recommended-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  if (badRest.status !== 400) {
    fail(`REST: expected 400 for missing incidentId, got ${badRest.status}`);
  }
  console.log("  ok (missing 'incidentId' returns 400)");

  const notFound = await fetch(`${API_BASE}/ai/recommended-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incidentId: `${RUN_TAG}-does-not-exist` })
  });
  if (notFound.status !== 404) {
    fail(`REST: expected 404 for unknown incidentId, got ${notFound.status}`);
  }
  console.log("  ok (unknown incidentId returns 404)");

  console.log("");
  console.log("REST recommendations:");
  console.log(JSON.stringify(restBody.recommendations, null, 2));
  console.log("");
  console.log("Retrieved runbooks (titles):");
  if (restBody.retrieved && restBody.retrieved.runbooks) {
    for (const r of restBody.retrieved.runbooks) {
      console.log(`  - ${r.title} [score=${r.score.toFixed(3)}]`);
    }
  }

  await getGlobalDispatcher().close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
