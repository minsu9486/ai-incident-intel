const { Kafka } = require("kafkajs");
const { connectCassandra, insertIncidentEvent } = require("./cassandra");

const kafka = new Kafka({
  clientId: "ai-incident-consumer",
  brokers: ["localhost:9092"]
});

const consumer = kafka.consumer({
  groupId: "incident-events-projection-group"
});

async function startConsumer() {
  await connectCassandra();
  await consumer.connect();

  await consumer.subscribe({
    topic: "incident-events",
    fromBeginning: true
  });

  console.log("Kafka consumer is running...");

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const rawValue = message.value.toString();
        const event = JSON.parse(rawValue);

        console.log(
          `Received message ${topic}[${partition}] offset=${message.offset} incidentId=${event.incidentId}`
        );

        await insertIncidentEvent(event);

        console.log(`Stored event ${event.id} in Cassandra`);
      } catch (error) {
        console.error("Failed to process Kafka message:", error);
      }
    }
  });
}

startConsumer().catch((error) => {
  console.error("Consumer failed to start:", error);
});