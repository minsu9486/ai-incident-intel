const SERVICE_TO_TEAM = {
  "payments-api": "payments",
  "payments-worker": "payments",
  "checkout-api": "payments",
  "auth-service": "identity",
  "identity-api": "identity",
  "session-service": "identity",
  "search-api": "discovery",
  "catalog-api": "discovery",
  "recommendations-api": "discovery",
  "shipping-api": "fulfillment",
  "warehouse-worker": "fulfillment",
  "notifications-api": "growth",
  "email-worker": "growth",
  "kafka-cluster": "platform",
  "cassandra-cluster": "platform",
  "ingest-gateway": "platform"
};

const UNKNOWN_TEAM = "unassigned";

function lookupTeamId(serviceName) {
  if (!serviceName) return UNKNOWN_TEAM;
  return SERVICE_TO_TEAM[serviceName] || UNKNOWN_TEAM;
}

module.exports = { lookupTeamId, UNKNOWN_TEAM };
