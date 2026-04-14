const express = require("express");
const cors = require("cors");
const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@as-integrations/express4");

const PORT = 4000;

const incidentEvents = [
  {
    id: "evt-1",
    incidentId: "inc-123",
    type: "INCIDENT_REPORTED",
    message: "CPU usage spike detected on payments-api",
    timestamp: new Date().toISOString()
  },
  {
    id: "evt-2",
    incidentId: "inc-123",
    type: "SEVERITY_SCORED",
    message: "Severity scored as HIGH",
    timestamp: new Date().toISOString()
  }
];

const typeDefs = `#graphql
  type IncidentEvent {
    id: ID!
    incidentId: ID!
    type: String!
    message: String!
    timestamp: String!
  }

  type Incident {
    incidentId: ID!
    events: [IncidentEvent!]!
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
    incidentTimeline: (_, { incidentId }) => {
      return incidentEvents.filter((event) => event.incidentId === incidentId);
    }
  },
  Mutation: {
    createIncident: (_, { input }) => {
      const newEvent = {
        id: `evt-${incidentEvents.length + 1}`,
        incidentId: input.incidentId,
        type: "INCIDENT_REPORTED",
        message: input.message,
        timestamp: new Date().toISOString()
      };

      incidentEvents.push(newEvent);

      return {
        success: true,
        event: newEvent
      };
    }
  }
};

async function startServer() {
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

  app.post("/incidents", (req, res) => {
    const { incidentId, message } = req.body;

    if (!incidentId || !message) {
      return res.status(400).json({
        ok: false,
        error: "incidentId and message are required"
      });
    }

    const newEvent = {
      id: `evt-${incidentEvents.length + 1}`,
      incidentId,
      type: "INCIDENT_REPORTED",
      message,
      timestamp: new Date().toISOString()
    };

    incidentEvents.push(newEvent);

    return res.status(201).json({
      ok: true,
      event: newEvent
    });
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