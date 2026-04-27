const { Type } = require("@google/genai");

const RECOMMENDED_ACTIONS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    recommended_actions: {
      type: Type.ARRAY,
      description: "Exactly 3 prioritized actions, sorted by priority ascending.",
      items: {
        type: Type.OBJECT,
        properties: {
          priority: {
            type: Type.INTEGER,
            description: "1 is highest priority, 3 is lowest."
          },
          action: {
            type: Type.STRING,
            description: "Imperative, specific action grounded in the supplied context."
          },
          reason: {
            type: Type.STRING,
            description: "1-2 sentences citing the evidence from similar incidents or runbooks."
          },
          confidence: {
            type: Type.STRING,
            format: "enum",
            enum: ["LOW", "MEDIUM", "HIGH"]
          },
          risk: {
            type: Type.STRING,
            format: "enum",
            enum: ["LOW", "MEDIUM", "HIGH"]
          }
        },
        required: ["priority", "action", "reason", "confidence", "risk"],
        propertyOrdering: ["priority", "action", "reason", "confidence", "risk"]
      },
      minItems: "3",
      maxItems: "3"
    },
    notes: {
      type: Type.STRING,
      description: "1-2 sentences. Mention uncertainty or weak evidence if applicable."
    }
  },
  required: ["recommended_actions", "notes"],
  propertyOrdering: ["recommended_actions", "notes"]
};

function formatIncident(incident) {
  return [
    `Incident ID: ${incident.incidentId}`,
    `Org ID: ${incident.orgId || "unknown"}`,
    `Service: ${incident.serviceName || "unknown"}`,
    `Severity: ${incident.severity || "unknown"}`,
    `Message: ${incident.message || ""}`
  ].join("\n");
}

function formatSimilarIncidents(matches) {
  if (!matches || matches.length === 0) return "(none)";
  return matches
    .map(
      (m, i) =>
        `${i + 1}. [${m.serviceName || "unknown"} | ${m.severity || "unknown"} | score=${m.score.toFixed(3)}] ${m.message}`
    )
    .join("\n");
}

function formatRunbooks(runbooks) {
  if (!runbooks || runbooks.length === 0) return "(none)";
  return runbooks
    .map(
      (r, i) =>
        `${i + 1}. ${r.title} [services=${r.services.join(",") || "any"} | severities=${r.severities.join(",") || "any"} | score=${r.score.toFixed(3)}]\n${r.content}`
    )
    .join("\n\n");
}

function buildRecommendedActionsPrompt({ incident, similarIncidents, runbooks }) {
  return `You are an incident response copilot for an AI Incident Intelligence Platform.

Your task is to recommend the next best actions for an on-call engineer handling the current incident.
Base your answer only on:
1. the current incident context,
2. similar historical incidents,
3. runbook snippets.

Do not invent tools, commands, services, or facts that are not present in the input.
Prefer safe, reversible, operationally useful actions.
If evidence is weak or conflicting, say so in the notes field rather than guessing.
Avoid generic advice such as "investigate further" unless you make it concrete and tied to a specific signal.

Output rules:
- recommended_actions: exactly 3 items, sorted by priority ascending (1 is most urgent).
- Each action must be imperative, specific, and grounded in evidence from the input.
- Prefer actions that map to runbook steps or to patterns seen in similar incidents.
- Include rollback or escalation logic when the situation warrants it.
- confidence and risk are independent: an action can be HIGH-confidence and HIGH-risk (e.g., emergency failover).
- notes: 1-2 sentences. Mention uncertainty when evidence is thin.
- No markdown, no code fences, no prose outside the JSON.

Current incident:
${formatIncident(incident)}

Similar historical incidents (top ${similarIncidents ? similarIncidents.length : 0}, ranked by vector similarity):
${formatSimilarIncidents(similarIncidents)}

Runbook snippets (top ${runbooks ? runbooks.length : 0}, retrieved by vector similarity, filtered by service/severity):
${formatRunbooks(runbooks)}

Task:
Generate the JSON recommended-actions response now.`;
}

module.exports = {
  RECOMMENDED_ACTIONS_SCHEMA,
  buildRecommendedActionsPrompt
};
