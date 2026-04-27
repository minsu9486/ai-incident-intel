const { GoogleGenAI } = require("@google/genai");

const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIM = 768;

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

function buildIncidentEmbeddingText(incident) {
  return [
    `Incident ID: ${incident.incidentId}`,
    `Org ID: ${incident.orgId || "unknown"}`,
    `Service: ${incident.serviceName || "unknown"}`,
    `Severity: ${incident.severity || "unknown"}`,
    `Message: ${incident.message || ""}`
  ].join("\n");
}

async function embed(text, taskType) {
  const response = await getClient().models.embedContent({
    model: process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
    contents: text,
    config: {
      taskType,
      outputDimensionality: EMBEDDING_DIM
    }
  });

  const values = response?.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIM) {
    throw new Error(
      `Gemini returned an invalid embedding (length=${values ? values.length : "n/a"}, expected ${EMBEDDING_DIM})`
    );
  }

  return values;
}

async function embedDocument(text) {
  return embed(text, "RETRIEVAL_DOCUMENT");
}

async function embedQuery(text) {
  return embed(text, "RETRIEVAL_QUERY");
}

module.exports = {
  EMBEDDING_DIM,
  buildIncidentEmbeddingText,
  embedDocument,
  embedQuery
};
