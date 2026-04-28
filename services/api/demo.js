/**
 * demo: one-shot end-to-end walkthrough of the platform.
 * Posts a single payments-api incident, waits for the projection consumer
 * and the enrichment consumer to land their rows, then exercises all three
 * AI endpoints (summary, similar-incident retrieval, runbook-RAG actions).
 * The output is annotated for screenshots / asciinema.
 *
 * Requires: docker compose up + schema applied + `npm start` +
 *           `npm run consumer` + `npm run enrichment-consumer` running.
 *           For AI steps: GEMINI_API_KEY in `services/api/.env` (loaded by
 *           the API, consumer, and this script) and `npm run index-runbooks`
 *           previously executed. Without GEMINI_API_KEY, AI steps are skipped.
 * Run:      npm run demo
 */
require("dotenv").config({ quiet: true });

const { getGlobalDispatcher } = require("undici");

const API_BASE = "http://localhost:4000";
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30000;

const RUN_TAG = `demo-${Date.now()}`;
const INCIDENT = {
  incidentId: `${RUN_TAG}-pay`,
  orgId: "demo-org",
  serviceName: "payments-api",
  severity: "CRITICAL",
  message:
    "Payments API timing out after the 14:02 deploy. Error rate jumped to 18% and p95 latency is at 4.2s. Repeated connection timeouts to postgres-primary; checkout funnel impacted."
};

function rule() {
  return "═".repeat(72);
}

function dim(text) {
  return `\x1b[2m${text}\x1b[0m`;
}

function bold(text) {
  return `\x1b[1m${text}\x1b[0m`;
}

function ok(text) {
  return `\x1b[32m${text}\x1b[0m`;
}

function warn(text) {
  return `\x1b[33m${text}\x1b[0m`;
}

function fail(message) {
  console.error(`\n\x1b[31mFAIL:\x1b[0m ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function step(n, total, title) {
  console.log("");
  console.log(`${bold(`▶ Step ${n}/${total}`)}  ${title}`);
}

function done(label, ms) {
  console.log(`            ${ok("✓")} ${label} ${dim(`(${ms}ms)`)}`);
}

function skipped(label, reason) {
  console.log(`            ${warn("⊘")} ${label} — ${reason}`);
}

async function timed(fn) {
  const t = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t };
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

async function postIncident() {
  const res = await fetch(`${API_BASE}/incidents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(INCIDENT)
  });
  const body = await res.json();
  if (!res.ok) fail(`POST /incidents returned ${res.status}: ${JSON.stringify(body)}`);
  return body.event;
}

async function callGraphql(query, variables) {
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

async function waitForProjection(incidentId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const data = await callGraphql(
      `query ($id: ID!) { incidentTimeline(incidentId: $id) { id type } }`,
      { id: incidentId }
    );
    if (data.incidentTimeline && data.incidentTimeline.length > 0) return;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(
    `incident did not project to incident_events_by_id within ${POLL_TIMEOUT_MS}ms. ` +
      "Is 'npm run consumer' running?"
  );
}

async function waitForEnrichment(incidentId, severityBucket, day) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const data = await callGraphql(
      `query ($sev: String!, $day: String!, $limit: Int!) {
         incidentsBySeverity(severityBucket: $sev, day: $day, limit: $limit) { incidentId }
       }`,
      { sev: severityBucket, day, limit: 50 }
    );
    const found = (data.incidentsBySeverity || []).some((r) => r.incidentId === incidentId);
    if (found) return;
    await sleep(POLL_INTERVAL_MS);
  }
  fail(
    `incident did not project to incidents_by_severity within ${POLL_TIMEOUT_MS}ms. ` +
      "Is 'npm run enrichment-consumer' running?"
  );
}

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`POST ${path} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function indent(text, n = 2) {
  const pad = " ".repeat(n);
  return String(text)
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

function printSummary(body) {
  console.log("");
  console.log(`  ${bold("Summary:")}        ${body.summary}`);
  console.log(`  ${bold("Customer impact:")} ${body.customer_impact}`);
  console.log(`  ${bold("Likely cause:")}    ${body.likely_root_cause}`);
  console.log(`  ${bold("Confidence:")}      ${body.confidence}`);
  if (Array.isArray(body.next_actions) && body.next_actions.length > 0) {
    console.log(`  ${bold("Next actions:")}`);
    body.next_actions.forEach((a, i) => console.log(`    ${i + 1}. ${a}`));
  }
  if (Array.isArray(body.signals) && body.signals.length > 0) {
    console.log(`  ${bold("Signals:")}`);
    body.signals.forEach((s) => console.log(`    • ${s}`));
  }
}

function printSimilar(matches) {
  console.log("");
  if (!matches || matches.length === 0) {
    console.log(`  ${dim("(no similar incidents found — fresh cluster or this is the first run)")}`);
    return;
  }
  console.log(`  ${bold("Top matches:")}`);
  for (const m of matches) {
    const score = typeof m.score === "number" ? m.score.toFixed(3) : "?";
    console.log(`    [score ${score}] ${m.incidentId}  ${dim(`${m.serviceName || "?"} / ${m.severity || "?"}`)}`);
    console.log(`      ${dim(m.message.slice(0, 110))}${m.message.length > 110 ? dim("…") : ""}`);
  }
}

function printRecommendations(body) {
  const runbooks = (body.retrieved && body.retrieved.runbooks) || [];
  const actions = (body.recommendations && body.recommendations.actions) || [];
  const notes = body.recommendations && body.recommendations.notes;

  console.log("");
  if (runbooks.length > 0) {
    console.log(`  ${bold("Retrieved runbooks:")}`);
    for (const r of runbooks) {
      const score = typeof r.score === "number" ? r.score.toFixed(3) : "?";
      console.log(`    • ${r.title} ${dim(`[score=${score}]`)}`);
    }
  } else {
    console.log(`  ${warn("(no runbooks retrieved — did you run 'npm run index-runbooks'?)")}`);
  }

  console.log("");
  console.log(`  ${bold("Recommended actions:")}`);
  for (const a of actions) {
    console.log(`    ${a.priority}. (conf ${a.confidence}, risk ${a.risk})  ${a.action}`);
    console.log(`        ${dim(a.reason)}`);
  }

  if (notes) {
    console.log("");
    console.log(`  ${bold("Notes:")} ${dim(notes)}`);
  }
}

async function main() {
  const totalStart = Date.now();

  console.log(rule());
  console.log(`  ${bold("AI Incident Intelligence — End-to-End Demo")}`);
  console.log(rule());
  console.log("");
  console.log("Assumptions:");
  console.log(`  • API:                 ${API_BASE}`);
  console.log("  • Projection consumer:  npm run consumer (running)");
  console.log("  • Enrichment consumer:  npm run enrichment-consumer (running)");
  console.log("  • Schema applied to Cassandra");
  console.log("  • Runbooks indexed:    npm run index-runbooks (already run)");
  console.log(
    `  • GEMINI_API_KEY:      ${process.env.GEMINI_API_KEY ? "set" : warn("not set — AI steps will be skipped")}`
  );

  const aiEnabled = Boolean(process.env.GEMINI_API_KEY);
  const totalSteps = 7;

  // Step 1
  step(1, totalSteps, "GET /health");
  const { ms: healthMs } = await timed(() => checkHealth());
  done("API reachable", healthMs);

  // Step 2
  step(2, totalSteps, "POST /incidents");
  console.log(`            ${dim(`incidentId:  ${INCIDENT.incidentId}`)}`);
  console.log(`            ${dim(`service:     ${INCIDENT.serviceName}`)}`);
  console.log(`            ${dim(`severity:    ${INCIDENT.severity}`)}`);
  const { result: published, ms: publishMs } = await timed(() => postIncident());
  done(`event published (id ${published.id.slice(0, 8)}…)`, publishMs);

  // Step 3
  step(3, totalSteps, "Wait for projection (Query.incidentTimeline)");
  console.log(`            ${dim("→ projection consumer writes incident_events_by_id")}`);
  const { ms: projectionMs } = await timed(() => waitForProjection(INCIDENT.incidentId));
  done("event landed in incident_events_by_id", projectionMs);

  // Step 4
  const day = new Date(published.timestamp).toISOString().slice(0, 10);
  step(4, totalSteps, "Wait for enrichment (Query.incidentsBySeverity)");
  console.log(`            ${dim(`→ enrichment consumer derives teamId, severityBucket, dayBucket`)}`);
  console.log(`            ${dim(`→ partition: (${INCIDENT.severity}, ${day})`)}`);
  const { ms: enrichmentMs } = await timed(() =>
    waitForEnrichment(INCIDENT.incidentId, INCIDENT.severity, day)
  );
  done("row landed in incidents_by_severity", enrichmentMs);

  // Step 5
  step(5, totalSteps, "POST /ai/incident-summary");
  if (!aiEnabled) {
    skipped("Gemini summary", "GEMINI_API_KEY not set");
  } else {
    console.log(`            ${dim("→ Gemini structured-JSON output")}`);
    try {
      const { result: summary, ms } = await timed(() =>
        postJson("/ai/incident-summary", {
          incidentId: INCIDENT.incidentId,
          orgId: INCIDENT.orgId,
          limit: 20
        })
      );
      done("summary generated", ms);
      printSummary(summary);
    } catch (err) {
      skipped("Gemini summary", err.message);
    }
  }

  // Step 6
  step(6, totalSteps, "POST /ai/similar-incidents (k=3)");
  console.log(`            ${dim("→ Cassandra 5 SAI ANN cosine search over incident_embeddings")}`);
  if (!aiEnabled) {
    skipped("similar-incident retrieval", "GEMINI_API_KEY not set (query embedding requires Gemini)");
  } else {
    try {
      const { result: similar, ms } = await timed(() =>
        postJson("/ai/similar-incidents", {
          incidentId: INCIDENT.incidentId,
          orgId: INCIDENT.orgId,
          serviceName: INCIDENT.serviceName,
          severity: INCIDENT.severity,
          message: INCIDENT.message,
          k: 3
        })
      );
      done(`returned ${similar.matches.length} matches`, ms);
      printSimilar(similar.matches);
    } catch (err) {
      skipped("similar-incident retrieval", err.message);
    }
  }

  // Step 7
  step(7, totalSteps, "POST /ai/recommended-actions (k=3)");
  console.log(`            ${dim("→ RAG: similar incidents + runbook chunks → Gemini")}`);
  if (!aiEnabled) {
    skipped("recommended actions", "GEMINI_API_KEY not set");
  } else {
    try {
      const { result: rec, ms } = await timed(() =>
        postJson("/ai/recommended-actions", {
          incidentId: INCIDENT.incidentId,
          k: 3
        })
      );
      done(`returned ${rec.recommendations.actions.length} actions`, ms);
      printRecommendations(rec);
    } catch (err) {
      skipped("recommended actions", err.message);
    }
  }

  console.log("");
  console.log(rule());
  console.log(`  ${bold(`Demo complete in ${((Date.now() - totalStart) / 1000).toFixed(1)}s`)}`);
  console.log(rule());
  console.log("");
  console.log("Try it interactively:");
  console.log(`  • Apollo Sandbox:  ${API_BASE}/graphql`);
  console.log("  • Sample queries:  services/api/SAMPLE_QUERIES.md");
  console.log(`  • Metrics:         ${API_BASE}/metrics`);
  console.log("");

  await getGlobalDispatcher().close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
