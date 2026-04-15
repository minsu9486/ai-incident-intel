const express = require("express");
const cors = require("cors");
const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@as-integrations/express4");
const { publishIncidentReported } = require("./kafka");
const { connectCassandra, getIncidentTimeline } = require("./cassandra");

const PORT = 4000;

function buildIncidentReportedEvent(incidentId, message) {
  return {
    id: `evt-${Date.now()}`,
    incidentId,
    type: "INCIDENT_REPORTED",
    message,
    timestamp: new Date().toISOString()
  };
}

const typeDefs = `#graphql
  type IncidentEvent {
    id: ID!
    incidentId: ID!
    type: String!
    message: String!
    timestamp: String!
  }

  input CreateIncidentInput {
    incidentId: ID!
    message: String!
  }

  type CreateIncidentPayload {
    success: Boolean!
    event: IncidentEvent!
  }

  type Query {
    health: String!
    incidentTimeline(incidentId: ID!): [IncidentEvent!]!
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
    }
  },
  Mutation: {
    createIncident: async (_, { input }) => {
      const newEvent = buildIncidentReportedEvent(input.incidentId, input.message);

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
      const { incidentId, message } = req.body;

      if (!incidentId || !message) {
        return res.status(400).json({
          ok: false,
          error: "incidentId and message are required"
        });
      }

      const newEvent = buildIncidentReportedEvent(incidentId, message);

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