const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@as-integrations/express4");
const { publishIncidentReported, publishArtifactAttached } = require("./kafka");
const {
  connectCassandra,
  getIncidentTimeline,
  getServiceHealthByOrg
} = require("./cassandra");
const {
  ensureBucketExists,
  uploadArtifact,
  getPresignedDownloadUrl
} = require("./minio");

const PORT = 4000;

const crypto = require("crypto");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

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

function buildArtifactAttachedEvent({ incidentId, artifact }) {
  return {
    id: crypto.randomUUID(),
    incidentId,
    type: "ARTIFACT_ATTACHED",
    message: `Artifact attached: ${artifact.originalName}`,
    timestamp: new Date().toISOString(),
    artifact
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
  await ensureBucketExists();

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

  app.post("/artifacts/upload", upload.single("file"), async (req, res) => {
    try {
      const incidentId = req.body.incidentId;

      if (!incidentId) {
        return res.status(400).json({
          ok: false,
          error: "incidentId is required"
        });
      }

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "file is required"
        });
      }

      const safeFileName = req.file.originalname.replace(/\s+/g, "-");
      const objectKey = `${incidentId}/${Date.now()}-${safeFileName}`;
      const mimeType = req.file.mimetype || "application/octet-stream";

      const putResult = await uploadArtifact({
        objectKey,
        buffer: req.file.buffer,
        mimeType
      });

      const artifact = {
        bucket: putResult.bucket,
        objectKey: putResult.objectKey,
        originalName: req.file.originalname,
        mimeType,
        size: req.file.size
      };

      const event = buildArtifactAttachedEvent({ incidentId, artifact });

      await publishArtifactAttached(event);

      return res.status(201).json({
        ok: true,
        artifact,
        event
      });
    } catch (error) {
      console.error("Artifact upload failed:", error);

      return res.status(500).json({
        ok: false,
        error: "Artifact upload failed"
      });
    }
  });

  app.get("/artifacts/*/download-url", async (req, res) => {
    try {
      const wildcardPath = req.params[0];
      const objectKey = decodeURIComponent(wildcardPath);

      const url = await getPresignedDownloadUrl(objectKey);

      return res.json({
        ok: true,
        objectKey,
        downloadUrl: url,
        expiresInSeconds: 900
      });
    } catch (error) {
      console.error("Failed to generate download URL:", error);

      return res.status(500).json({
        ok: false,
        error: "Failed to generate signed download URL"
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
    console.log(`REST upload artifact: POST http://localhost:${PORT}/artifacts/upload`);
    console.log(`REST signed URL: GET http://localhost:${PORT}/artifacts/<objectKey>/download-url`);
    console.log(`GraphQL endpoint: http://localhost:${PORT}/graphql`);
  });
}

startServer().catch((err) => {
  console.error("Server failed to start:", err);
});