const {
  findSimilarIncidentsByVector,
  findSimilarRunbooksByVector
} = require("./cassandra");
const {
  buildIncidentEmbeddingText,
  embedQuery
} = require("./embeddings");

async function findSimilarIncidents({
  incidentId,
  orgId,
  serviceName,
  severity,
  message,
  k
}) {
  const queryText = buildIncidentEmbeddingText({
    incidentId,
    orgId,
    serviceName,
    severity,
    message
  });
  const queryEmbedding = await embedQuery(queryText);
  const topK = Math.max(1, k || 3);
  const candidates = await findSimilarIncidentsByVector(queryEmbedding, topK + 1);
  return candidates
    .filter((row) => row.incidentId !== incidentId)
    .slice(0, topK);
}

async function findSimilarRunbooks({
  incidentId,
  orgId,
  serviceName,
  severity,
  message,
  k
}) {
  const queryText = buildIncidentEmbeddingText({
    incidentId,
    orgId,
    serviceName,
    severity,
    message
  });
  const queryEmbedding = await embedQuery(queryText);
  const topK = Math.max(1, k || 3);
  return findSimilarRunbooksByVector(queryEmbedding, topK, {
    serviceName,
    severity
  });
}

module.exports = {
  findSimilarIncidents,
  findSimilarRunbooks
};
