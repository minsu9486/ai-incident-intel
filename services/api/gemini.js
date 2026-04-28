const { GoogleGenAI } = require("@google/genai");
const config = require("./config");
const {
  buildIncidentSummaryPrompt,
  INCIDENT_SUMMARY_SCHEMA
} = require("./prompts/incident-summary");

let client;

function getClient() {
  if (client) return client;

  if (!config.gemini.apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return client;
}

async function generateIncidentSummary({ incidentId, orgId, events, serviceHealth }) {
  const prompt = buildIncidentSummaryPrompt({ incidentId, orgId, events, serviceHealth });

  const response = await getClient().models.generateContent({
    model: config.gemini.model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: INCIDENT_SUMMARY_SCHEMA,
      temperature: 0.2
    }
  });

  const text = response.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return JSON.parse(text);
}

module.exports = { generateIncidentSummary };
