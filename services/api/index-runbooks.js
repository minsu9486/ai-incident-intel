const config = require("./config");

const fs = require("fs/promises");
const path = require("path");
const {
  connectCassandra,
  upsertRunbookEmbedding
} = require("./cassandra");
const { embedDocument } = require("./embeddings");

const RUNBOOKS_DIR = path.join(__dirname, "runbooks");

function parseFrontMatter(raw) {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("missing front-matter (expected --- … --- block at top)");
  }

  const meta = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    if (line.trim() === "") continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const valueRaw = line.slice(sep + 1).trim();
    if (valueRaw.startsWith("[") && valueRaw.endsWith("]")) {
      meta[key] = valueRaw
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      meta[key] = valueRaw;
    }
  }

  return { meta, body: match[2].trim() };
}

function buildRunbookEmbeddingText({ title, services, severities, tags, body }) {
  return [
    `Title: ${title}`,
    `Services: ${services.join(", ") || "any"}`,
    `Severities: ${severities.join(", ") || "any"}`,
    `Tags: ${tags.join(", ") || "(none)"}`,
    "",
    body
  ].join("\n");
}

async function loadRunbookFile(file) {
  const raw = await fs.readFile(path.join(RUNBOOKS_DIR, file), "utf8");
  const { meta, body } = parseFrontMatter(raw);

  if (!meta.id || !meta.title) {
    throw new Error(`${file}: front-matter must include 'id' and 'title'`);
  }

  return {
    runbookId: meta.id,
    title: meta.title,
    services: meta.services || [],
    severities: meta.severities || [],
    tags: meta.tags || [],
    content: body
  };
}

async function main() {
  if (!config.gemini.apiKey) {
    console.error("GEMINI_API_KEY is not set. Add it to services/api/.env.");
    process.exit(1);
  }

  await connectCassandra();

  const files = (await fs.readdir(RUNBOOKS_DIR)).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.error(`No runbooks found in ${RUNBOOKS_DIR}`);
    process.exit(1);
  }

  console.log(`Indexing ${files.length} runbooks from ${RUNBOOKS_DIR}`);

  let indexed = 0;
  for (const file of files) {
    const startedAt = Date.now();
    try {
      const runbook = await loadRunbookFile(file);
      const embeddingText = buildRunbookEmbeddingText({
        title: runbook.title,
        services: runbook.services,
        severities: runbook.severities,
        tags: runbook.tags,
        body: runbook.content
      });
      const embedding = await embedDocument(embeddingText);
      await upsertRunbookEmbedding({
        runbookId: runbook.runbookId,
        title: runbook.title,
        services: runbook.services,
        severities: runbook.severities,
        tags: runbook.tags,
        content: runbook.content,
        embeddingText,
        embedding
      });
      indexed += 1;
      console.log(
        `  ok  ${file} (id=${runbook.runbookId}) in ${Date.now() - startedAt}ms`
      );
    } catch (error) {
      console.error(`  fail  ${file}: ${error.message}`);
    }
  }

  console.log(`Indexed ${indexed}/${files.length} runbooks (768-dim).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("index-runbooks failed:", err);
  process.exit(1);
});
