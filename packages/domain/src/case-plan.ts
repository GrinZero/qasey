import { createHash } from "node:crypto";
import {
  parseMeterSphereBulkOperation,
  type MeterSphereCaseOperationReceipt,
  type MeterSphereCaseRecord,
} from "./metersphere-receipt.ts";

export interface MeterSphereCasePlanItem {
  key: string;
  operation: "create" | "update";
  name: string;
  order: number;
  targetModuleId: string;
  targetModulePath: string;
  caseId?: string | undefined;
}

export interface MeterSphereCasePlanTargetModule {
  id: string;
  path: string;
}

export interface MeterSphereCasePlan {
  version: 1;
  planHash: string;
  payloadHash: string;
  plannedCount: number;
  cases: MeterSphereCasePlanItem[];
  targetModules: MeterSphereCasePlanTargetModule[];
  /** Canonical dry-run payload. Real writes reuse this exact ordered set. */
  writeItems: Array<Record<string, unknown>>;
}

export function buildMeterSphereCasePlan(options: {
  dryRunInput: unknown;
  dryRunResult: unknown;
}): MeterSphereCasePlan | undefined {
  const operation = parseMeterSphereBulkOperation(options.dryRunInput, options.dryRunResult);
  if (!operation?.dryRun || !operation.success) return undefined;
  const input = isRecord(options.dryRunInput) ? options.dryRunInput : {};
  const writeItems = parseItems(input.items ?? input.cases);
  if (writeItems.length === 0 || operation.itemCount !== writeItems.length) return undefined;

  const cases = writeItems.map((item, index): MeterSphereCasePlanItem | undefined => {
    const operationName = stringValue(item.operation).toLowerCase();
    if (operationName !== "create" && operationName !== "update") return undefined;
    const caseId = stringValue(item.case_id ?? item.caseId ?? item.id);
    const resultCase = operation.cases.find(candidate =>
      (caseId && candidate.id === caseId)
      || (stringValue(item.name) && candidate.name === stringValue(item.name)),
    ) ?? operation.cases[index];
    const name = stringValue(item.name) || resultCase?.name || "";
    const targetModuleId = stringValue(item.node_id ?? item.nodeId) || resultCase?.nodeId || "";
    const targetModulePath = stringValue(item.node_path ?? item.nodePath) || resultCase?.nodePath || "";
    if (!name || !targetModuleId || !targetModulePath) return undefined;
    const identity = operationName === "update" && caseId
      ? `update:${caseId}`
      : `create:${targetModuleId}:${targetModulePath}:${name}`;
    return {
      key: `case_${sha256(identity).slice(0, 20)}`,
      operation: operationName,
      name,
      order: index + 1,
      targetModuleId,
      targetModulePath,
      ...(caseId ? { caseId } : {}),
    };
  });
  if (cases.some(item => !item)) return undefined;
  const plannedCases = cases as MeterSphereCasePlanItem[];
  if (new Set(plannedCases.map(item => item.key)).size !== plannedCases.length) return undefined;

  const targetModules = [...new Map(plannedCases.map(item => [
    `${item.targetModuleId}:${item.targetModulePath}`,
    { id: item.targetModuleId, path: item.targetModulePath },
  ])).values()];
  const payloadHash = sha256(stableStringify(writeItems));
  const planBody = {
    version: 1 as const,
    payloadHash,
    plannedCount: plannedCases.length,
    cases: plannedCases,
    targetModules,
    writeItems,
  };
  return { ...planBody, planHash: sha256(stableStringify(planBody)) };
}

export function validateMeterSphereCasePlan(plan: unknown): MeterSphereCasePlan {
  if (!isRecord(plan)
    || plan.version !== 1
    || typeof plan.planHash !== "string"
    || typeof plan.payloadHash !== "string"
    || !Number.isInteger(plan.plannedCount)
    || (plan.plannedCount as number) < 1
    || !Array.isArray(plan.cases)
    || !plan.cases.every(isCasePlanItem)
    || !Array.isArray(plan.targetModules)
    || !plan.targetModules.every(isCasePlanTargetModule)
    || !Array.isArray(plan.writeItems)
    || !plan.writeItems.every(isRecord)) {
    throw new Error("Persisted MeterSphere CasePlan failed integrity validation");
  }
  const cloned: unknown = structuredClone(plan);
  const candidate = cloned as MeterSphereCasePlan;
  const { planHash, ...body } = candidate;
  if (candidate.plannedCount !== candidate.cases.length
    || candidate.plannedCount !== candidate.writeItems.length
    || new Set(candidate.cases.map(item => item.key)).size !== candidate.cases.length
    || sha256(stableStringify(candidate.writeItems)) !== candidate.payloadHash
    || sha256(stableStringify(body)) !== planHash) {
    throw new Error("Persisted MeterSphere CasePlan failed integrity validation");
  }
  return candidate;
}

export function completeCaseOperationAgainstPlan(
  plan: MeterSphereCasePlan,
  operation: MeterSphereCaseOperationReceipt | undefined,
): MeterSphereCaseOperationReceipt | undefined {
  if (!operation) return undefined;

  const usedIds = new Set<string>();
  const orderedCases: MeterSphereCaseRecord[] = [];
  for (const planned of plan.cases) {
    const match = operation.cases.find(candidate => !usedIds.has(candidate.id)
      && candidate.verified
      && candidate.name === planned.name
      && candidate.nodeId === planned.targetModuleId
      && candidate.nodePath === planned.targetModulePath);
    if (!match) return undefined;
    usedIds.add(match.id);
    orderedCases.push(match);
  }
  if (usedIds.size !== plan.plannedCount) return undefined;

  const plannedCreates = plan.cases.filter(item => item.operation === "create").length;
  const plannedUpdates = plan.cases.filter(item => item.operation === "update").length;
  if (operation.createdCount !== plannedCreates || operation.updatedCount !== plannedUpdates) return undefined;
  return {
    ...operation,
    cases: orderedCases,
    itemCount: plan.plannedCount,
    verifiedCount: plan.plannedCount,
  };
}

export function casePlanSummary(plan: MeterSphereCasePlan): string {
  return [
    "## 已持久化的不可变 CasePlan",
    `- plan_hash: ${plan.planHash}`,
    `- planned_count: ${plan.plannedCount}`,
    "- 必须继续使用这份计划，不得重新生成、增删、改名、改序或更换目标模块。",
    ...plan.cases.map(item => `${item.order}. [${item.key}] ${item.name} -> ${item.targetModulePath} (${item.targetModuleId})`),
  ].join("\n");
}

export function tryCasePlanSummary(value: unknown): string | undefined {
  try {
    return casePlanSummary(validateMeterSphereCasePlan(value));
  } catch {
    return undefined;
  }
}

function parseItems(value: unknown): Array<Record<string, unknown>> {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter(isRecord).map(item => structuredClone(item)) : [];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try { return parseJson(JSON.parse(trimmed)); } catch { return value; }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCasePlanItem(value: unknown): value is MeterSphereCasePlanItem {
  if (!isRecord(value)) return false;
  return typeof value.key === "string"
    && (value.operation === "create" || value.operation === "update")
    && typeof value.name === "string"
    && Number.isInteger(value.order)
    && (value.order as number) > 0
    && typeof value.targetModuleId === "string"
    && typeof value.targetModulePath === "string"
    && (value.caseId === undefined || typeof value.caseId === "string");
}

function isCasePlanTargetModule(value: unknown): value is MeterSphereCasePlanTargetModule {
  return isRecord(value) && typeof value.id === "string" && typeof value.path === "string";
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
