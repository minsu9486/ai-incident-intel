const Minio = require("minio");
const config = require("./config");
const baseLogger = require("./logger");

const logger = baseLogger.child({ module: "minio" });

const BUCKET_NAME = config.minio.bucket;

const minioClient = new Minio.Client({
  endPoint: config.minio.endpoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey
});

async function ensureBucketExists() {
  const exists = await minioClient.bucketExists(BUCKET_NAME);

  if (!exists) {
    await minioClient.makeBucket(BUCKET_NAME, "us-east-1");
    logger.info({ bucket: BUCKET_NAME }, "created bucket");
  }
}

async function uploadArtifact({ objectKey, buffer, mimeType }) {
  await minioClient.putObject(
    BUCKET_NAME,
    objectKey,
    buffer,
    buffer.length,
    { "Content-Type": mimeType }
  );

  return { bucket: BUCKET_NAME, objectKey };
}

async function getPresignedDownloadUrl(objectKey) {
  const expirySeconds = 60 * 15;
  return await minioClient.presignedGetObject(
    BUCKET_NAME,
    objectKey,
    expirySeconds
  );
}

module.exports = {
  BUCKET_NAME,
  ensureBucketExists,
  uploadArtifact,
  getPresignedDownloadUrl
};
