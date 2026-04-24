const Minio = require("minio");

const BUCKET_NAME = "incident-artifacts";

const minioClient = new Minio.Client({
  endPoint: "localhost",
  port: 9000,
  useSSL: false,
  accessKey: "minioadmin",
  secretKey: "minioadmin"
});

async function ensureBucketExists() {
  const exists = await minioClient.bucketExists(BUCKET_NAME);

  if (!exists) {
    await minioClient.makeBucket(BUCKET_NAME, "us-east-1");
    console.log(`Created bucket: ${BUCKET_NAME}`);
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
