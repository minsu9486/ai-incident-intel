const express = require("express");
const cors = require("cors");
const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@as-integrations/express4");
const { publishIncidentReported } = require("./kafka");
const {
  connectCassandra,
  getIncidentTimeline,
  getServiceHealthByOrg
} = require("./cassandra");

const PORT = 4000;

const crypto = require("crypto");

function buildIncidentReportedEvent(input) {
  return {
    id: crypto.randomUUID(),
    incidentId: input.incidentId,
    orgId: input.orgId,
    serviceName: input.serviceName,
    severity: input.severity,
    type: "INCIDENT_REPORTED",
    message: input.message,
    timestamp: new Date().toISOString()
  };
}

const typeDefs = `#graphql
  type IncidentEvent {
    id: ID!
    incidentId: ID!
    orgId: ID
    serviceName: String
    severity: String
    type: String!
    message: String!
    timestamp: String!
  }

  type ServiceHealth {
    orgId: ID!
    serviceName: String!
    latestIncidentId: ID!
    latestEventId: ID!
    severity: String!
    status: String!
    lastUpdated: String!
    message: String!
  }

  input CreateIncidentInput {
    incidentId: ID!
    orgId: ID!
    serviceName: String!
    severity: String!
    message: String!
  }

  type CreateIncidentPayload {
    success: Boolean!
    event: IncidentEvent!
  }

  type Query {
    health: String!
    incidentTimeline(incidentId: ID!): [IncidentEvent!]!
    serviceHealthByOrg(orgId: ID!): [ServiceHealth!]!
  }

  type Mutation {
    createIncident(input: CreateIncidentInput!): CreateIncidentPayload!
  }
`;

const resolvers = {
  Query: {
    health: () => "ok",
    incidentTimeline: async (_, { incidentId }) => {
      return await getIncidentTimeline(incidentId);
    },
    serviceHealthByOrg: async (_, { orgId }) => {
      return await getServiceHealthByOrg(orgId);
    }
  },
  Mutation: {
    createIncident: async (_, { input }) => {
      const newEvent = buildIncidentReportedEvent(input);

      await publishIncidentReported(newEvent);

      return {
        success: true,
        event: newEvent
      };
    }
  }
};

async function startServer() {
  await connectCassandra();

  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "ai-incident-api",
      timestamp: new Date().toISOString()
    });
  });

  app.post("/incidents", async (req, res) => {
    try {
      const { incidentId, orgId, serviceName, severity, message } = req.body;

      if (!incidentId || !orgId || !serviceName || !severity || !message) {
        return res.status(400).json({
          ok: false,
          error: "incidentId, orgId, serviceName, severity, and message are required"
        });
      }

      const newEvent = buildIncidentReportedEvent({
        incidentId,
        orgId,
        serviceName,
        severity,
        message
      });

      await publishIncidentReported(newEvent);

      return res.status(201).json({
        ok: true,
        event: newEvent
      });
    } catch (error) {
      console.error("Failed to create incident:", error);

      return res.status(500).json({
        ok: false,
        error: "Failed to publish incident event"
      });
    }
  });

  const server = new ApolloServer({
    typeDefs,
    resolvers
  });

  await server.start();

  app.use("/graphql", expressMiddleware(server));

  app.listen(PORT, () => {
    console.log(`REST health: http://localhost:${PORT}/health`);
    console.log(`REST create incident: POST http://localhost:${PORT}/incidents`);
    console.log(`GraphQL endpoint: http://localhost:${PORT}/graphql`);
  });
}

startServer().catch((err) => {
  console.error("Server failed to start:", err);
});