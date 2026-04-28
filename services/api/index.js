const config = require("./config");
const baseLogger = require("./logger");

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pinoHttp = require("pino-http");
const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@as-integrations/express4");
const { register: metricsRegister } = require("./metrics");
const { publishIncidentReported, publishArtifactAttached } = require("./kafka");
const {
  connectCassandra,
  getIncidentTimeline,
  getServiceHealthByOrg,
  getArtifactsByIncident,
  getIncidentsByTeam,
  getIncidentsBySeverity
} = require("./cassandra");
const {
  ensureBucketExists,
  uploadArtifact,
  getPresignedDownloadUrl
} = require("./minio");
const { generateIncidentSummary } = require("./gemini");
const { findSimilarIncidents } = require("./retrieval");
const { generateRecommendedActions } = require("./recommendations");

const logger = baseLogger.child({ service: "api" });

const PORT = config.api.port;

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

  type IncidentArtifact {
    artifactId: ID!
    incidentId: ID!
    bucket: String!
    objectKey: String!
    originalName: String!
    mimeType: String!
    sizeBytes: Int!
    uploadedAt: String!
    downloadUrl: String!
  }

  type IncidentSummary {
    incidentId: ID!
    summary: String!
    customerImpact: String!
    likelyRootCause: String!
    confidence: String!
    nextActions: [String!]!
    signals: [String!]!
  }

  type SimilarIncidentMatch {
    incidentId: ID!
    orgId: ID
    serviceName: String
    severity: String
    message: String!
    score: Float!
  }

  type RecommendedAction {
    priority: Int!
    action: String!
    reason: String!
    confidence: String!
    risk: String!
  }

  type RecommendedActions {
    incidentId: ID!
    actions: [RecommendedAction!]!
    notes: String!
  }

  type EnrichedIncident {
    incidentId: ID!
    orgId: ID
    serviceName: String
    teamId: String
    severity: String
    severityBucket: String
    message: String!
    reportedAt: String!
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
    incidentArtifacts(incidentId: ID!): [IncidentArtifact!]!
    incidentSummary(incidentId: ID!, orgId: ID, limit: Int = 20): IncidentSummary!
    similarIncidents(
      incidentId: ID!
      orgId: ID
      serviceName: String
      severity: String
      message: String!
      k: Int = 3
    ): [SimilarIncidentMatch!]!
    recommendedActions(incidentId: ID!, k: Int = 3): RecommendedActions!
    incidentsByTeam(teamId: String!, limit: Int = 50): [EnrichedIncident!]!
    incidentsBySeverity(severityBucket: String!, day: String!, limit: Int = 50): [EnrichedIncident!]!
  }

  type Mutation {
    createIncident(input: CreateIncidentInput!): CreateIncidentPayload!
  }
`;

async function buildSummary({ incidentId, orgId, limit }) {
  const allEvents = await getIncidentTimeline(incidentId);
  const events = allEvents.slice(0, limit);

  if (events.length === 0) {
    const err = new Error(`No events found for incident ${incidentId}`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const serviceHealth = orgId ? await getServiceHealthByOrg(orgId) : [];

  return generateIncidentSummary({ incidentId, orgId, events, serviceHealth });
}

const resolvers = {
  Query: {
    health: () => "ok",
    incidentTimeline: async (_, { incidentId }) => {
      return await getIncidentTimeline(incidentId);
    },
    serviceHealthByOrg: async (_, { orgId }) => {
      return await getServiceHealthByOrg(orgId);
    },
    incidentArtifacts: async (_, { incidentId }) => {
      const artifacts = await getArtifactsByIncident(incidentId);

      return await Promise.all(
        artifacts.map(async (artifact) => ({
          ...artifact,
          downloadUrl: await getPresignedDownloadUrl(artifact.objectKey)
        }))
      );
    },
    incidentSummary: async (_, { incidentId, orgId, limit }) => {
      const out = await buildSummary({ incidentId, orgId, limit });
      return {
        incidentId,
        summary: out.summary,
        customerImpact: out.customer_impact,
        likelyRootCause: out.likely_root_cause,
        confidence: out.confidence,
        nextActions: out.next_actions,
        signals: out.signals
      };
    },
    similarIncidents: async (_, args) => {
      return await findSimilarIncidents(args);
    },
    recommendedActions: async (_, { incidentId, k }) => {
      const out = await generateRecommendedActions({ incidentId, k });
      return {
        incidentId,
        actions: out.actions,
        notes: out.notes
      };
    },
    incidentsByTeam: async (_, { teamId, limit }) => {
      return await getIncidentsByTeam(teamId, limit);
    },
    incidentsBySeverity: async (_, { severityBucket, day, limit }) => {
      return await getIncidentsBySeverity(severityBucket, day, limit);
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

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === "/metrics" || req.url === "/health"
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      }
    })
  );
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "ai-incident-api",
      timestamp: new Date().toISOString()
    });
  });

  app.get("/metrics", async (_req, res) => {
    try {
      res.setHeader("Content-Type", metricsRegister.contentType);
      res.end(await metricsRegister.metrics());
    } catch (error) {
      res.status(500).send(error.message);
    }
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
      req.log.error({ err: error.message }, "failed to create incident");

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
      req.log.error({ err: error.message }, "artifact upload failed");

      return res.status(500).json({
        ok: false,
        error: "Artifact upload failed"
      });
    }
  });

  app.post("/ai/incident-summary", async (req, res) => {
    try {
      const { incidentId, orgId, limit = 20 } = req.body || {};

      if (!incidentId) {
        return res.status(400).json({
          ok: false,
          error: "incidentId is required"
        });
      }

      const summary = await buildSummary({ incidentId, orgId, limit });

      return res.json({ ok: true, incidentId, ...summary });
    } catch (error) {
      req.log.error({ err: error.message }, "AI incident summary failed");

      const status = error.code === "NOT_FOUND" ? 404 : 500;
      return res.status(status).json({
        ok: false,
        error: error.message || "Failed to generate incident summary"
      });
    }
  });

  app.post("/ai/similar-incidents", async (req, res) => {
    try {
      const {
        incidentId,
        orgId,
        serviceName,
        severity,
        message,
        k = 3
      } = req.body || {};

      if (!incidentId || !message) {
        return res.status(400).json({
          ok: false,
          error: "incidentId and message are required"
        });
      }

      const matches = await findSimilarIncidents({
        incidentId,
        orgId,
        serviceName,
        severity,
        message,
        k
      });

      return res.json({ ok: true, matches });
    } catch (error) {
      req.log.error({ err: error.message }, "similar incident lookup failed");

      return res.status(500).json({
        ok: false,
        error: error.message || "Similar incident lookup failed"
      });
    }
  });

  app.post("/ai/recommended-actions", async (req, res) => {
    try {
      const { incidentId, k = 3 } = req.body || {};

      if (!incidentId) {
        return res.status(400).json({
          ok: false,
          error: "incidentId is required"
        });
      }

      const out = await generateRecommendedActions({ incidentId, k });

      return res.json({
        ok: true,
        incidentId,
        recommendations: {
          actions: out.actions,
          notes: out.notes
        },
        retrieved: {
          similarIncidents: out.similarIncidents,
          runbooks: out.runbooks.map((r) => ({
            runbookId: r.runbookId,
            title: r.title,
            services: r.services,
            severities: r.severities,
            score: r.score
          }))
        }
      });
    } catch (error) {
      req.log.error({ err: error.message }, "recommended actions generation failed");

      const status = error.code === "NOT_FOUND" ? 404 : 500;
      return res.status(status).json({
        ok: false,
        error: error.message || "Recommended actions generation failed"
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
      req.log.error({ err: error.message }, "failed to generate download URL");

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
    logger.info({ port: PORT }, "api listening");
  });
}

startServer().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, "server failed to start");
  process.exit(1);
});