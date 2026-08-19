import { readFile } from "node:fs/promises";
import path from "node:path";
import { mastra } from "../../../src/mastra/index.ts";
import { QASEY_MCP_ALLOWED_TOOL_NAMES } from "../../../packages/adapters/src/mcp.ts";
import { QASEY_READ_CONNECTOR_TOOL_NAMES } from "../../../packages/adapters/src/read-connectors.ts";

const DATASET_ID = "qasey-real-qa-workflows-v1-safe";
const DATASET_NAME = "Qasey Real QA Workflows v1 — Safe (live reads, mocked writes)";
const SCORER_IDS = ["qasey-visible-output", "qasey-required-behavior", "qasey-forbidden-behavior"];
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const itemsPath = path.join(repoRoot, "evals/golden/exports/mastra-safe-items.json");
const toolEffectsPath = path.join(repoRoot, "evals/golden/tool-effects.v1.json");

const desiredItems = JSON.parse(await readFile(itemsPath, "utf8")) as Array<Record<string, any> & { externalId: string }>;
const toolEffects = JSON.parse(await readFile(toolEffectsPath, "utf8")) as {
  sideEffectTools: string[];
  readOnlyTools: string[];
};

assertPotentialToolsAreClassified();
assertEverySideEffectIsMocked();

const dataset = await getOrCreateDataset();
await dataset.update({
  name: DATASET_NAME,
  description: "真实 QA 工作流金标。读取工具连接真实系统；所有已分类写工具由 dataset tool mocks 拦截，不修改外部业务数据。",
  metadata: {
    schemaVersion: "1.0",
    source: "evals/golden/qa-workflows.v1.json",
    experimentMode: "live_reads_mocked_writes",
    sideEffectRegistry: "evals/golden/tool-effects.v1.json",
    piiStatus: "sanitized",
    importedBy: "evals/golden/scripts/import-mastra-safe.ts",
  },
  tags: ["qasey", "golden", "real-qa", "zh-CN", "safe-experiment", "live-reads", "mocked-writes"],
  targetType: "agent",
  targetIds: ["qasey"],
  scorerIds: SCORER_IDS,
});

const current = await listAllItems();
const currentByExternalId = new Map(current.filter(item => item.externalId).map(item => [item.externalId, item]));
let created = 0;
let updated = 0;
let unchanged = 0;

for (const desired of desiredItems) {
  const existing = currentByExternalId.get(desired.externalId);
  if (!existing) {
    await dataset.addItem(desired);
    created += 1;
    continue;
  }
  const desiredPayload = withoutExternalId(desired);
  const existingPayload = selectComparablePayload(existing);
  if (stableJson(existingPayload) === stableJson(desiredPayload)) {
    unchanged += 1;
    continue;
  }
  await dataset.updateItem({ itemId: existing.id, ...desiredPayload });
  updated += 1;
}

const details = await dataset.getDetails();
const verifiedItems = await listAllItems();
const importedIds = new Set(desiredItems.map(item => item.externalId));
const verified = verifiedItems.filter(item => item.externalId && importedIds.has(item.externalId));
if (verified.length !== desiredItems.length) {
  throw new Error(`Mastra read-back mismatch: expected ${desiredItems.length}, found ${verified.length}`);
}
for (const item of verified) assertItemSafety(item);

console.log(JSON.stringify({
  datasetId: details.id,
  name: details.name,
  version: details.version,
  experimentMode: "live_reads_mocked_writes",
  mockedSideEffectTools: toolEffects.sideEffectTools,
  scorerIds: details.scorerIds,
  created,
  updated,
  unchanged,
  verifiedCount: verified.length,
}, null, 2));

await mastra.shutdown();

function assertPotentialToolsAreClassified() {
  const classified = new Set([...toolEffects.sideEffectTools, ...toolEffects.readOnlyTools]);
  const potential = new Set([
    ...QASEY_MCP_ALLOWED_TOOL_NAMES,
    ...QASEY_READ_CONNECTOR_TOOL_NAMES,
    "getCurrentTime",
    "e2eCreateRun",
    "e2eGetRun",
    "e2eRerun",
    "qasey_report_progress",
    "qasey_read_evidence_artifact",
    "code",
  ]);
  const unknown = [...potential].filter(toolName => !classified.has(toolName)).sort();
  if (unknown.length > 0) {
    throw new Error(`Safe import refused: classify potential runtime tools first: ${unknown.join(", ")}`);
  }
}

function assertEverySideEffectIsMocked() {
  for (const item of desiredItems) assertItemSafety(item);
}

function assertItemSafety(item: Record<string, any>) {
  if (item.unmockedToolPolicy !== "allow") {
    throw new Error(`${item.externalId ?? item.id}: expected unmockedToolPolicy=allow for live reads`);
  }
  const mocked = new Set((item.toolMocks ?? []).map((mock: { toolName: string }) => mock.toolName));
  const missing = toolEffects.sideEffectTools.filter(toolName => !mocked.has(toolName));
  if (missing.length > 0) {
    throw new Error(`${item.externalId ?? item.id}: missing side-effect mocks: ${missing.join(", ")}`);
  }
  const accidentallyMockedReads = toolEffects.readOnlyTools.filter(toolName => mocked.has(toolName));
  if (accidentallyMockedReads.length > 0) {
    throw new Error(`${item.externalId ?? item.id}: read-only tools must stay live: ${accidentallyMockedReads.join(", ")}`);
  }
}

async function getOrCreateDataset() {
  try {
    const existing = await mastra.datasets.get({ id: DATASET_ID });
    await existing.getDetails();
    return existing;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return mastra.datasets.create({
      id: DATASET_ID,
      name: DATASET_NAME,
      description: "Qasey safe golden dataset with live reads and mocked writes",
      targetType: "agent",
      targetIds: ["qasey"],
      scorerIds: SCORER_IDS,
    });
  }
}

async function listAllItems() {
  const items: Array<Record<string, any>> = [];
  let page = 0;
  while (true) {
    const result = await dataset.listItems({ page, perPage: 100 });
    if (Array.isArray(result)) return result;
    items.push(...result.items);
    if (!result.pagination.hasMore) return items;
    page += 1;
  }
}

function withoutExternalId(item: Record<string, unknown>) {
  const { externalId: _externalId, ...payload } = item;
  return payload;
}

function selectComparablePayload(item: Record<string, any>) {
  return Object.fromEntries(
    ["input", "groundTruth", "expectedTrajectory", "toolMocks", "unmockedToolPolicy", "scorerIds", "requestContext", "metadata", "source"]
      .filter(key => item[key] !== undefined)
      .map(key => [key, item[key]]),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not[ _-]?found|404/i.test(message);
}
