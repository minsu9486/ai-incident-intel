const { Type } = require("@google/genai");

const INCIDENT_SUMMARY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: "2-4 sentences, under 90 words, plain prose."
    },
    customer_impact: {
      type: Type.STRING,
      description: "1-2 sentences describing user-facing impact."
    },
    likely_root_cause: {
      type: Type.STRING,
      description: "If unclear, say 'Unknown based on current evidence'."
    },
    confidence: {
      type: Type.STRING,
      format: "enum",
      enum: ["LOW", "MEDIUM", "HIGH"]
    },
    next_actions: {
      type: Type.ARRAY,
      description: "Exactly 3 imperative, specific next actions.",
      items: { type: Type.STRING },
      minItems: "3",
      maxItems: "3"
    },
    signals: {
      type: Type.ARRAY,
      description: "Exactly 3 concrete observations from the provided context.",
      items: { type: Type.STRING },
      minItems: "3",
      maxItems: "3"
    }
  },
  required: [
    "summary",
    "customer_impact",
    "likely_root_cause",
    "confidence",
    "next_actions",
    "signals"
  ],
  propertyOrdering: [
    "summary",
    "customer_impact",
    "likely_root_cause",
    "confidence",
    "next_actions",
    "signals"
  ]
};

function formatEvents(events) {
  if (!events || events.length === 0) return "(none)";
  return events
    .map((e, i) => `${i + 1}. ${e.timestamp} - ${e.type} - ${e.message}`)
    .join("\n");
}

function formatServiceHealth(serviceHealth) {
  if (!serviceHealth || serviceHealth.length === 0) return "(not provided)";
  return serviceHealth
    .map(
      (s) =>
        `- ${s.serviceName}: ${s.status} (severity=${s.severity}) — ${s.message} @ ${s.lastUpdated}`
    )
    .join("\n");
}

function buildIncidentSummaryPrompt({ incidentId, orgId, events, serviceHealth }) {
  return `You are an incident response copilot for an AI Incident Intelligence Platform.

Your job is to summarize a production incident for an on-call engineer.
Be precise, operationally useful, and cautious.
Do not invent facts that are not present in the input.
If evidence is weak or conflicting, say so explicitly.
Prefer concrete observations over speculation.
Use short, direct sentences.

Output rules:
- summary: 2-4 sentences, under 90 words total, no markdown.
- customer_impact: 1-2 sentences.
- likely_root_cause: say "Unknown based on current evidence" if unclear.
- confidence: choose LOW, MEDIUM, or HIGH based on evidence strength.
- next_actions: exactly 3 items, each imperative and specific.
- signals: exactly 3 concrete observations drawn from the incident context below.
- No markdown, no code fences, no prose outside the JSON.

Incident context:
Incident ID: ${incidentId}
Org ID: ${orgId || "unknown"}

Recent incident events (newest first):
${formatEvents(events)}

Current service health (org-wide latest state):
${formatServiceHealth(serviceHealth)}

Task:
Generate the JSON incident summary now.`;
}

module.exports = {
  INCIDENT_SUMMARY_SCHEMA,
  buildIncidentSummaryPrompt
};
