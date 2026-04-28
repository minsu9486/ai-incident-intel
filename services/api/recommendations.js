const { GoogleGenAI } = require("@google/genai");
const config = require("./config");
const { getIncidentLatestSnapshot } = require("./cassandra");
const { findSimilarIncidents, findSimilarRunbooks } = require("./retrieval");
const {
  RECOMMENDED_ACTIONS_SCHEMA,
  buildRecommendedActionsPrompt
} = require("./prompts/recommended-actions");

let client;

function getClient() {
  if (client) return client;

  if (!config.gemini.apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return client;
}

async function generateRecommendedActions({ incidentId, k }) {
  const incident = await getIncidentLatestSnapshot(incidentId);
  if (!incident) {
    const err = new Error(
      `No indexed snapshot found for incident ${incidentId}. ` +
        "The incident may not have been indexed yet (consumer lag or Gemini outage)."
    );
    err.code = "NOT_FOUND";
    throw err;
  }

  const topK = Math.max(1, k || 3);

  const [similarIncidents, runbooks] = await Promise.all([
    findSimilarIncidents({ ...incident, k: topK }),
    findSimilarRunbooks({ ...incident, k: topK })
  ]);

  const prompt = buildRecommendedActionsPrompt({
    incident,
    similarIncidents,
    runbooks
  });

  const response = await getClient().models.generateContent({
    model: config.gemini.model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: RECOMMENDED_ACTIONS_SCHEMA,
      temperature: 0.2
    }
  });

  const text = response.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  const parsed = JSON.parse(text);

  return {
    incident,
    similarIncidents,
    runbooks,
    actions: parsed.recommended_actions,
    notes: parsed.notes
  };
}

module.exports = { generateRecommendedActions };
