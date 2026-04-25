const { GoogleGenAI } = require("@google/genai");
const {
  buildIncidentSummaryPrompt,
  INCIDENT_SUMMARY_SCHEMA
} = require("./prompts/incident-summary");

const DEFAULT_MODEL = "gemini-2.5-flash";

let client;

function getClient() {
  if (client) return client;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  client = new GoogleGenAI({ apiKey });
  return client;
}

async function generateIncidentSummary({ incidentId, orgId, events, serviceHealth }) {
  const prompt = buildIncidentSummaryPrompt({ incidentId, orgId, events, serviceHealth });

  const response = await getClient().models.generateContent({
    model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
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
