import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const sourcePath = path.join(repoRoot, "evals/golden/qa-workflows.v1.json");
const sourceEvidencePath = path.join(repoRoot, "evals/golden/source-evidence.v1.json");
const toolEffectsPath = path.join(repoRoot, "evals/golden/tool-effects.v1.json");
const outputDir = path.join(repoRoot, "evals/golden/exports");

const dataset = JSON.parse(await readFile(sourcePath, "utf8"));
const sourceEvidence = JSON.parse(await readFile(sourceEvidencePath, "utf8"));
const toolEffects = JSON.parse(await readFile(toolEffectsPath, "utf8"));
validateDataset(dataset);
validateSourceEvidence(sourceEvidence);
validateToolEffects(toolEffects);

const evidenceByFile = new Map(sourceEvidence.sources.map(source => [source.file, source]));
const sourceHashCache = new Map();
for (const record of dataset.records) {
  const evidence = evidenceByFile.get(record.source.file);
  if (!evidence) throw new Error(`${record.id}: no provenance snapshot for ${record.source.file}`);
  if (!evidence.excerpts.includes(record.source.excerpt)) {
    throw new Error(`${record.id}: source excerpt was not found in the provenance snapshot for ${record.source.file}`);
  }
  if (!evidence.goldenIds.includes(record.id)) throw new Error(`${record.id}: missing golden id in provenance snapshot`);
  sourceHashCache.set(record.source.file, evidence.originalSha256);
}

const golden = dataset.records.filter(record => record.status === "golden");
const canonical = golden.map(record => ({
  ...record,
  source: {
    ...record.source,
    sha256: sourceHashCache.get(record.source.file),
  },
}));

const mastraItems = canonical.map(record => ({
  externalId: record.id,
  input: record.input.priorContext?.length
    ? [...record.input.priorContext, { role: "user", content: record.input.message }]
    : record.input.message,
  groundTruth: record.groundTruth,
  expectedTrajectory: record.expectedTrajectory,
  requestContext: buildMastraRequestContext(record),
  metadata: buildMetadata(record),
  source: { type: "json", referenceId: `${record.source.file}#${record.source.excerpt}` },
}));

const mastraSafeItems = canonical.map(record => ({
  externalId: record.id,
  input: record.input.priorContext?.length
    ? [...record.input.priorContext, { role: "user", content: record.input.message }]
    : record.input.message,
  groundTruth: {
    ...record.groundTruth,
    capabilityTrajectory: record.expectedTrajectory,
  },
  expectedTrajectory: buildNativeTrajectoryExpectation(),
  toolMocks: buildSideEffectMocks(record, toolEffects.sideEffectTools),
  // Read-only tools intentionally use live connectors. Every known mutation is
  // explicitly mocked and the import script refuses unclassified runtime tools.
  unmockedToolPolicy: "allow",
  scorerIds: ["qasey-visible-output", "qasey-required-behavior", "qasey-forbidden-behavior"],
  requestContext: buildMastraRequestContext(record),
  metadata: {
    ...buildMetadata(record),
    experiment_mode: "live_reads_mocked_writes",
    mocked_tool_count: toolEffects.sideEffectTools.length,
  },
  source: { type: "json", referenceId: `${record.source.file}#${record.source.excerpt}` },
}));

const datadogRecords = canonical.map(record => ({
  input: {
    message: record.input.message,
    ...(record.input.priorContext ? { prior_context: record.input.priorContext } : {}),
    ...(record.input.attachments ? { attachments: record.input.attachments } : {}),
  },
  expected_output: {
    ...record.groundTruth,
    expectedTrajectory: record.expectedTrajectory,
  },
  metadata: buildMetadata(record),
}));

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDir, "canonical.jsonl"), toJsonl(canonical)),
  writeFile(path.join(outputDir, "mastra-items.json"), `${JSON.stringify(mastraItems, null, 2)}\n`),
  writeFile(path.join(outputDir, "mastra-safe-items.json"), `${JSON.stringify(mastraSafeItems, null, 2)}\n`),
  writeFile(path.join(outputDir, "datadog-records.json"), `${JSON.stringify(datadogRecords, null, 2)}\n`),
  writeFile(path.join(outputDir, "datadog-records.csv"), toDatadogCsv(datadogRecords)),
  writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(buildManifest(canonical), null, 2)}\n`),
]);

console.log(`Built ${canonical.length} golden records in ${path.relative(repoRoot, outputDir)}`);

function validateDataset(value) {
  if (!value || value.schemaVersion !== "1.0" || !Array.isArray(value.records)) {
    throw new Error("Invalid dataset envelope");
  }
  const ids = new Set();
  for (const record of value.records) {
    if (!/^qasey-gw-\d{3}$/.test(record.id)) throw new Error(`Invalid record id: ${record.id}`);
    if (ids.has(record.id)) throw new Error(`Duplicate record id: ${record.id}`);
    ids.add(record.id);
    if (!record.input?.message?.trim()) throw new Error(`${record.id}: missing input.message`);
    if (!record.groundTruth?.route?.intent) throw new Error(`${record.id}: missing route ground truth`);
    if (!Array.isArray(record.groundTruth.mustInclude) || record.groundTruth.mustInclude.length === 0) {
      throw new Error(`${record.id}: mustInclude cannot be empty`);
    }
    if (!Array.isArray(record.expectedTrajectory?.requiredCapabilities)) {
      throw new Error(`${record.id}: missing requiredCapabilities`);
    }
    assertSanitized(record);
    assertWriteContract(record);
  }
}

function validateSourceEvidence(value) {
  if (!value || value.schemaVersion !== "1.0" || value.mode !== "minimal_sanitized_provenance" || !Array.isArray(value.sources)) {
    throw new Error("Invalid source evidence snapshot");
  }
  const files = new Set();
  for (const source of value.sources) {
    if (files.has(source.file)) throw new Error(`Duplicate source evidence: ${source.file}`);
    files.add(source.file);
    if (!/^[a-f0-9]{64}$/.test(source.originalSha256)) throw new Error(`Invalid source hash: ${source.file}`);
    if (!Array.isArray(source.goldenIds) || !Array.isArray(source.excerpts)) throw new Error(`Invalid source evidence arrays: ${source.file}`);
    assertSanitized({ input: { evidence: source.excerpts }, groundTruth: {}, metadata: {} });
  }
}

function validateToolEffects(value) {
  if (!value || value.schemaVersion !== "1.0") throw new Error("Invalid tool effect registry");
  if (!Array.isArray(value.sideEffectTools) || !Array.isArray(value.readOnlyTools)) {
    throw new Error("Tool effect registry must contain sideEffectTools and readOnlyTools");
  }
  const all = [...value.sideEffectTools, ...value.readOnlyTools];
  if (new Set(all).size !== all.length) throw new Error("Tool effect registry contains duplicate classifications");
  if (!value.sideEffectTools.includes("metersphere_ms_bulk_upsert_test_cases")) {
    throw new Error("Tool effect registry must classify MeterSphere bulk upsert as a side effect");
  }
}

function buildNativeTrajectoryExpectation() {
  return {
    ordering: "relaxed",
    allowRepeatedSteps: true,
    maxSteps: 80,
    maxRetriesPerTool: 2,
    noRedundantCalls: true,
    blacklistedTools: ["metersphere_ms_delete_test_case", "metersphere_ms_delete_module"],
  };
}

function buildSideEffectMocks(record, sideEffectTools) {
  return sideEffectTools.flatMap(toolName => {
    const outputs = mockOutputs(toolName, record);
    return outputs.map(output => ({ toolName, matchArgs: "ignore", args: {}, output }));
  });
}

function mockOutputs(toolName, record) {
  const fixtureId = `fixture-${record.id}`;
  const common = {
    success: true,
    mocked: true,
    fixtureId,
    goldenId: record.id,
    notice: "Golden experiment mock: no external mutation was performed.",
  };
  if (toolName === "metersphere_ms_bulk_upsert_test_cases") {
    return [
      { ...common, dry_run: true, created_count: 1, updated_count: 0, unchanged_count: 0, validation_errors: [] },
      { ...common, dry_run: false, created_count: 1, updated_count: 0, unchanged_count: 0, case_ids: [`${fixtureId}-case-1`] },
      { ...common, dry_run: false, created_count: 0, updated_count: 1, unchanged_count: 0, case_ids: [`${fixtureId}-case-1`] },
    ];
  }
  if (toolName === "metersphere_ms_upsert_module") {
    return [{ ...common, module_id: `${fixtureId}-module`, path: `/Golden/Safe/${record.id}` }];
  }
  if (/metersphere_ms_(create|edit|batch_edit)_test_case/.test(toolName)) {
    return [
      { ...common, case_id: `${fixtureId}-case-1`, status: "simulated" },
      { ...common, case_id: `${fixtureId}-case-2`, status: "simulated" },
    ];
  }
  if (toolName === "qaExperience_qa_experience_upsert") {
    return [{ ...common, experience_id: `${fixtureId}-experience`, status: "simulated" }];
  }
  if (toolName === "e2eCreateRun" || toolName === "e2eRerun") {
    return [{ ...common, id: `${fixtureId}-e2e-run`, status: "queued_simulation" }];
  }
  if (toolName === "qasey_report_progress") {
    return [{ ...common, accepted: true, milestone: "golden-experiment-simulation" }];
  }
  throw new Error(`No mock fixture builder for side-effect tool ${toolName}`);
}

function assertSanitized(record) {
  const uploadable = JSON.stringify({ input: record.input, groundTruth: record.groundTruth, metadata: record.metadata });
  const forbidden = ["/Users/", "@moego.pet", "moegoworkspace.slack.com/archives/", "moego.atlassian.net/browse/"];
  for (const marker of forbidden) {
    if (uploadable.includes(marker)) throw new Error(`${record.id}: uploadable payload contains unsanitized marker ${marker}`);
  }
}

function assertWriteContract(record) {
  const { writeTarget } = record.groundTruth.route;
  const { writePolicy, readbackRequired } = record.groundTruth;
  if (writeTarget === "metersphere" && writePolicy === "none") {
    throw new Error(`${record.id}: MeterSphere route cannot use writePolicy=none`);
  }
  if (writePolicy === "metersphere_upsert" && !readbackRequired) {
    throw new Error(`${record.id}: MeterSphere upsert must require read-back`);
  }
  if (record.expectedTrajectory.forbiddenCapabilities.includes("metersphere_delete") === false) {
    throw new Error(`${record.id}: every v1 record must explicitly forbid agent-side MeterSphere deletion`);
  }
}

function buildMastraRequestContext(record) {
  const sessionId = `golden-${record.id}`;
  const attachments = (record.input.attachments ?? []).map((attachment, index) => ({
    id: `${record.id}-attachment-${index + 1}`,
    name: attachment.name,
    mimeType: attachment.mimeType,
    source: attachment.source,
  }));
  return {
    "qasey-context": {
      requestId: record.id,
      channel: "api",
      sessionId,
      chatInput: record.input.message,
      actor: { id: "golden-fixture" },
      source: {},
      attachments,
    },
  };
}

function buildMetadata(record) {
  return {
    golden_id: record.id,
    workflow: record.metadata.workflow,
    difficulty: record.metadata.difficulty,
    tags: record.metadata.tags,
    language: "zh-CN",
    pii_status: "sanitized",
    source_kind: "real_qa_chat",
    source_file: record.source.file,
    source_sha256: record.source.sha256,
    dataset_version: "1.0",
    ...(record.metadata.notes ? { notes: record.metadata.notes } : {}),
  };
}

function buildManifest(records) {
  const byWorkflow = Object.fromEntries(
    [...new Set(records.map(record => record.metadata.workflow))]
      .sort()
      .map(workflow => [workflow, records.filter(record => record.metadata.workflow === workflow).length]),
  );
  const byIntent = Object.fromEntries(
    [...new Set(records.map(record => record.groundTruth.route.intent))]
      .sort()
      .map(intent => [intent, records.filter(record => record.groundTruth.route.intent === intent).length]),
  );
  return {
    schemaVersion: dataset.schemaVersion,
    datasetName: dataset.name,
    recordCount: records.length,
    byWorkflow,
    byIntent,
    sourceFiles: [...new Set(records.map(record => record.source.file))].sort(),
    provenance: "../source-evidence.v1.json",
    rawSourceRequired: false,
    exportFormats: {
      canonical: "canonical.jsonl",
      mastra: "mastra-items.json",
      mastraSafe: "mastra-safe-items.json",
      datadogJson: "datadog-records.json",
      datadogCsv: "datadog-records.csv",
    },
  };
}

function toJsonl(items) {
  return `${items.map(item => JSON.stringify(item)).join("\n")}\n`;
}

function toDatadogCsv(records) {
  const header = ["input", "expected_output", "metadata"];
  const rows = records.map(record => [record.input, record.expected_output, record.metadata].map(value => csvCell(JSON.stringify(value))));
  return `${header.join(",")}\n${rows.map(row => row.join(",")).join("\n")}\n`;
}

function csvCell(value) {
  return `"${value.replaceAll('"', '""')}"`;
}
