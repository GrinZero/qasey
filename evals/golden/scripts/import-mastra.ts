import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { mastra } from "../../../src/mastra/index.ts";

const DATASET_ID = "qasey-real-qa-workflows-v1";
const DATASET_NAME = "Qasey Real QA Workflows v1";
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const itemsPath = path.join(repoRoot, "evals/golden/exports/mastra-items.json");

const desiredItems = JSON.parse(await readFile(itemsPath, "utf8")) as Array<Record<string, unknown> & { externalId: string }>;
const dataset = await getOrCreateDataset();

await dataset.update({
  name: DATASET_NAME,
  description: "32 条从真实 QA 对话提炼并脱敏的工作流级金标，覆盖建例、维护、纠错、发布、回查与删除安全。",
  metadata: {
    schemaVersion: "1.0",
    source: "evals/golden/qa-workflows.v1.json",
    piiStatus: "sanitized",
    importedBy: "evals/golden/scripts/import-mastra.ts",
  },
  tags: ["qasey", "golden", "real-qa", "zh-CN"],
  targetType: "agent",
  targetIds: ["qasey"],
});

const current = await listAllItems();
const currentByExternalId = new Map(
  current.filter(item => item.externalId).map(item => [item.externalId, item]),
);

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
const verifiedCount = verifiedItems.filter(item => item.externalId && importedIds.has(item.externalId)).length;

if (verifiedCount !== desiredItems.length) {
  throw new Error(`Mastra read-back mismatch: expected ${desiredItems.length}, found ${verifiedCount}`);
}

console.log(JSON.stringify({
  datasetId: details.id,
  name: details.name,
  version: details.version,
  targetType: details.targetType,
  targetIds: details.targetIds,
  created,
  updated,
  unchanged,
  verifiedCount,
}, null, 2));

await mastra.shutdown();

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
      description: "Qasey real QA workflow golden dataset",
      targetType: "agent",
      targetIds: ["qasey"],
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
