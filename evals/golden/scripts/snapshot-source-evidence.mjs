import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const sourceDir = path.join(repoRoot, "evals/soruce_case/chat-export");
const datasetPath = path.join(repoRoot, "evals/golden/qa-workflows.v1.json");
const outputPath = path.join(repoRoot, "evals/golden/source-evidence.v1.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));

const recordsByFile = new Map();
for (const record of dataset.records) {
  const entries = recordsByFile.get(record.source.file) ?? [];
  entries.push({ id: record.id, excerpt: record.source.excerpt });
  recordsByFile.set(record.source.file, entries);
}

const sourceFiles = (await readdir(sourceDir, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
  .map(entry => path.join(sourceDir, entry.name))
  .sort();

const sources = [];
for (const absoluteSource of sourceFiles) {
  const relativeSource = path.relative(repoRoot, absoluteSource);
  const sourceText = await readFile(absoluteSource, "utf8");
  const references = recordsByFile.get(relativeSource) ?? [];
  for (const reference of references) {
    if (!sourceText.includes(reference.excerpt)) {
      throw new Error(`${reference.id}: source excerpt was not found in ${relativeSource}`);
    }
    assertSanitized(reference.excerpt, `${reference.id} excerpt`);
  }
  sources.push({
    file: relativeSource,
    originalSha256: sha256(sourceText),
    originalBytes: (await stat(absoluteSource)).size,
    disposition: references.length > 0 ? "golden_source" : dispositionFor(relativeSource),
    goldenIds: references.map(reference => reference.id),
    excerpts: [...new Set(references.map(reference => reference.excerpt))],
  });
}

for (const [file, references] of recordsByFile) {
  if (!sources.some(source => source.file === file)) {
    throw new Error(`Canonical dataset references missing source ${file}: ${references.map(item => item.id).join(", ")}`);
  }
}

const snapshot = {
  schemaVersion: "1.0",
  mode: "minimal_sanitized_provenance",
  description: "Content-addressed inventory plus only the exact sanitized excerpts used by canonical golden records. Raw chat bodies are intentionally omitted.",
  sources,
};
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Snapshotted ${sources.length} Markdown sources and ${dataset.records.length} golden references to ${path.relative(repoRoot, outputPath)}`);

function dispositionFor(file) {
  if (/20260626-1359_|20260626-1834_|20260712-2133_/.test(file)) return "excluded_non_qa";
  if (/20260731-1848_/.test(file)) return "excluded_unstable_artifact_handoff";
  if (/20260804-1157_/.test(file)) return "excluded_connector_integration";
  if (file.endsWith("/INDEX.md")) return "index_only";
  return "reviewed_no_standalone_golden";
}

function assertSanitized(value, label) {
  const forbidden = ["/Users/", "@moego.pet", "moegoworkspace.slack.com/archives/", "moego.atlassian.net/browse/", "n8n-webhook.devops.moego.pet"];
  for (const marker of forbidden) {
    if (value.includes(marker)) throw new Error(`${label} contains unsanitized marker ${marker}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
