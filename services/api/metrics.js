const http = require("node:http");
const promClient = require("prom-client");
const baseLogger = require("./logger");

const logger = baseLogger.child({ module: "metrics" });

const register = new promClient.Registry();

promClient.collectDefaultMetrics({ register });

const eventsPublishedTotal = new promClient.Counter({
  name: "events_published_total",
  help: "Total events published to Kafka, labeled by topic.",
  labelNames: ["topic"],
  registers: [register]
});

const eventsConsumedTotal = new promClient.Counter({
  name: "events_consumed_total",
  help: "Total events consumed from Kafka, labeled by topic and consumer group.",
  labelNames: ["topic", "consumer_group"],
  registers: [register]
});

const eventsDlqTotal = new promClient.Counter({
  name: "events_dlq_total",
  help: "Total events sent to DLQ, labeled by consumer group and reason.",
  labelNames: ["consumer_group", "reason"],
  registers: [register]
});

const eventRetriesTotal = new promClient.Counter({
  name: "event_retries_total",
  help: "Total retry attempts for event processing, labeled by consumer group.",
  labelNames: ["consumer_group"],
  registers: [register]
});

const eventProcessingDurationSeconds = new promClient.Histogram({
  name: "event_processing_duration_seconds",
  help: "End-to-end duration of processing one Kafka message, labeled by consumer group.",
  labelNames: ["consumer_group"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

const eventEndToEndLagSeconds = new promClient.Histogram({
  name: "event_end_to_end_lag_seconds",
  help: "Wall-clock lag from event.timestamp to projection insert, labeled by consumer group.",
  labelNames: ["consumer_group"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
  registers: [register]
});

const kafkaConsumerLagMessages = new promClient.Gauge({
  name: "kafka_consumer_lag_messages",
  help: "Kafka consumer lag in messages, labeled by topic, partition, and consumer group.",
  labelNames: ["topic", "partition", "consumer_group"],
  registers: [register]
});

const kafkaConsumerEventsTotal = new promClient.Counter({
  name: "kafka_consumer_events_total",
  help: "Internal KafkaJS consumer events (heartbeat, commit_offsets, crash, etc).",
  labelNames: ["consumer_group", "event"],
  registers: [register]
});

function recordPublished(topic) {
  eventsPublishedTotal.inc({ topic });
}

function recordConsumed(topic, consumerGroup) {
  eventsConsumedTotal.inc({ topic, consumer_group: consumerGroup });
}

function recordDlq(consumerGroup, reason) {
  eventsDlqTotal.inc({ consumer_group: consumerGroup, reason });
}

function recordRetry(consumerGroup) {
  eventRetriesTotal.inc({ consumer_group: consumerGroup });
}

function startProcessingTimer(consumerGroup) {
  return eventProcessingDurationSeconds.startTimer({ consumer_group: consumerGroup });
}

function observeEndToEndLag(consumerGroup, eventTimestampIso) {
  const eventMs = Date.parse(eventTimestampIso);
  if (Number.isNaN(eventMs)) return;
  const lagSeconds = (Date.now() - eventMs) / 1000;
  if (lagSeconds < 0) return;
  eventEndToEndLagSeconds.observe({ consumer_group: consumerGroup }, lagSeconds);
}

function setKafkaLag({ topic, partition, consumerGroup, lag }) {
  kafkaConsumerLagMessages.set(
    { topic, partition: String(partition), consumer_group: consumerGroup },
    lag
  );
}

function recordKafkaInternalEvent(consumerGroup, eventName) {
  kafkaConsumerEventsTotal.inc({ consumer_group: consumerGroup, event: eventName });
}

function startMetricsServer({ port, name }) {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      try {
        res.setHeader("Content-Type", register.contentType);
        res.end(await register.metrics());
      } catch (error) {
        res.statusCode = 500;
        res.end(error.message);
      }
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  server.listen(port, () => {
    logger.info({ port, server: name }, "metrics server listening");
  });

  return server;
}

function startKafkaLagPoller({ admin, topics, consumerGroup, intervalMs = 10000 }) {
  let stopped = false;

  async function poll() {
    if (stopped) return;
    try {
      for (const topic of topics) {
        const [topicOffsets, groupOffsets] = await Promise.all([
          admin.fetchTopicOffsets(topic),
          admin.fetchOffsets({ groupId: consumerGroup, topics: [topic] })
        ]);

        const groupByPartition = new Map();
        const groupTopicEntry = groupOffsets.find((g) => g.topic === topic);
        if (groupTopicEntry) {
          for (const part of groupTopicEntry.partitions) {
            groupByPartition.set(part.partition, part.offset);
          }
        }

        for (const part of topicOffsets) {
          const high = Number(part.high);
          const committedRaw = groupByPartition.get(part.partition);
          // -1 means no committed offset yet
          const committed = committedRaw && committedRaw !== "-1" ? Number(committedRaw) : 0;
          const lag = Math.max(0, high - committed);
          setKafkaLag({
            topic,
            partition: part.partition,
            consumerGroup,
            lag
          });
        }
      }
    } catch (error) {
      logger.warn({ err: error.message, consumerGroup }, "kafka lag poll failed");
    }
  }

  const handle = setInterval(poll, intervalMs);
  if (handle.unref) handle.unref();
  // First poll immediately
  poll();

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    }
  };
}

function attachKafkajsConsumerEventMetrics(consumer, consumerGroup) {
  const events = consumer.events;
  if (!events) return;
  const interesting = ["HEARTBEAT", "COMMIT_OFFSETS", "GROUP_JOIN", "REBALANCING", "CRASH"];
  for (const eventName of interesting) {
    const symbol = events[eventName];
    if (!symbol) continue;
    consumer.on(symbol, () => {
      recordKafkaInternalEvent(consumerGroup, eventName.toLowerCase());
    });
  }
}

module.exports = {
  register,
  recordPublished,
  recordConsumed,
  recordDlq,
  recordRetry,
  startProcessingTimer,
  observeEndToEndLag,
  setKafkaLag,
  recordKafkaInternalEvent,
  startMetricsServer,
  startKafkaLagPoller,
  attachKafkajsConsumerEventMetrics
};
