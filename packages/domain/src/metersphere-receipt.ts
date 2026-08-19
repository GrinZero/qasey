export interface MeterSphereCaseRecord {
  id: string;
  num: string | number;
  name: string;
  priority: string;
  verified: boolean;
  nodeId?: string;
  nodePath?: string;
}

export interface MeterSphereCaseOperationReceipt {
  moduleId: string;
  modulePath: string;
  featureName: string;
  cases: MeterSphereCaseRecord[];
  itemCount: number;
  createdCount: number;
  updatedCount: number;
  verifiedCount: number;
  verificationMode: "internal_read_back" | "separate_read_back";
}

export interface MeterSphereBulkOperation {
  dryRun: boolean;
  success: boolean;
  itemCount: number;
  createdCount: number;
  updatedCount: number;
  modulePath: string;
  cases: MeterSphereCaseRecord[];
}

interface MeterSphereModuleRecord {
  id: string;
  path: string;
  name: string;
  verified: boolean;
}

export function parseMeterSphereBulkOperation(input: unknown, result: unknown): MeterSphereBulkOperation | undefined {
  const payload = decodedRecords(result).find(record =>
    "dry_run" in record && ("results" in record || "creates" in record || "item_count" in record),
  );
  if (!payload) return undefined;
  const inputRecord = isRecord(input) ? input : {};
  const inputItems = parseItems(inputRecord.items ?? inputRecord.cases);
  const operationCases = payload.results ?? payload.cases ?? payload.items
    ?? [payload.creates, payload.updates];
  const cases = enrichCaseMetadata(extractCaseRecords(operationCases), inputItems);
  const dryRun = booleanValue(payload.dry_run) ?? booleanValue(inputRecord.dry_run) ?? false;
  const itemCount = integerValue(payload.item_count) ?? (inputItems.length || cases.length);
  return {
    dryRun,
    success: booleanValue(payload.success) ?? booleanValue(payload.validated) ?? cases.length > 0,
    itemCount,
    createdCount: integerValue(payload.created_count) ?? (dryRun ? 0 : cases.filter(item => item.id).length),
    updatedCount: integerValue(payload.updated_count) ?? 0,
    modulePath: commonModulePath([
      ...cases.map(item => item.nodePath).filter((value): value is string => Boolean(value)),
      ...inputItems.map(item => stringValue(item.node_path ?? item.nodePath)).filter(Boolean),
    ]),
    cases,
  };
}

function parseMeterSphereSingleOperation(input: unknown, result: unknown): MeterSphereBulkOperation | undefined {
  const inputRecord = isRecord(input) ? input : {};
  if (!stringValue(inputRecord.name) || !stringValue(inputRecord.node_id ?? inputRecord.nodeId)) return undefined;
  const cases = enrichCaseMetadata(extractCaseRecordsFromResult(result), [inputRecord]);
  if (cases.length === 0) return undefined;
  const explicitlyVerifiedIds = new Set(decodedRecords(result)
    .filter(record => booleanValue(record.verified) === true)
    .map(record => stringValue(record.id ?? record.caseId ?? record.case_id))
    .filter(Boolean));
  if (cases.some(testCase => !explicitlyVerifiedIds.has(testCase.id))) return undefined;
  const updating = Boolean(stringValue(inputRecord.id ?? inputRecord.case_id ?? inputRecord.caseId));
  return {
    dryRun: false,
    success: true,
    itemCount: cases.length,
    createdCount: updating ? 0 : cases.length,
    updatedCount: updating ? cases.length : 0,
    modulePath: commonModulePath([
      ...cases.map(item => item.nodePath).filter((value): value is string => Boolean(value)),
      stringValue(inputRecord.node_path ?? inputRecord.nodePath),
    ].filter(Boolean)),
    cases,
  };
}

export function buildMeterSphereCaseOperationReceipt(options: {
  writeInput: unknown;
  writeResult: unknown;
  verificationResult?: unknown;
  moduleResults?: unknown[];
}): MeterSphereCaseOperationReceipt | undefined {
  const bulk = parseMeterSphereBulkOperation(options.writeInput, options.writeResult)
    ?? parseMeterSphereSingleOperation(options.writeInput, options.writeResult);
  if (!bulk || bulk.dryRun || !bulk.success) return undefined;

  const verificationCases = options.verificationResult
    ? extractCaseRecordsFromResult(options.verificationResult)
    : [];
  const cases = verificationCases.length > 0
    ? mergeVerifiedCases(verificationCases, bulk.cases)
    : bulk.cases;
  if (cases.length === 0) return undefined;
  const verifiedCount = cases.filter(item => item.verified).length;
  const verificationMode = options.verificationResult ? "separate_read_back" : "internal_read_back";
  if (verificationMode === "internal_read_back" && verifiedCount !== cases.length) return undefined;

  const casePaths = cases.map(item => item.nodePath).filter((value): value is string => Boolean(value));
  const commonPath = bulk.modulePath || commonModulePath(
    cases.map(item => item.nodePath).filter((value): value is string => Boolean(value)),
  );
  const moduleRecords = (options.moduleResults ?? []).flatMap(extractModuleRecords);
  const featureModule = moduleRecords
    .filter(module => module.verified && casePaths.every(path => path === module.path || path.startsWith(`${module.path}/`)))
    .sort((left, right) => pathDepth(left.path) - pathDepth(right.path))[0];
  const modulePath = featureModule?.path ?? commonPath;
  const exactModule = moduleRecords.find(module => module.path === modulePath && module.verified);
  const caseModule = cases.find(item => item.nodePath === modulePath && item.nodeId);
  const fallbackModule = cases.find(item => item.nodeId);
  const moduleId = exactModule?.id ?? caseModule?.nodeId ?? fallbackModule?.nodeId ?? "";
  if (!moduleId) return undefined;

  return {
    moduleId,
    modulePath,
    featureName: featureNameFromPath(modulePath),
    cases,
    itemCount: bulk.itemCount || cases.length,
    createdCount: bulk.createdCount,
    updatedCount: bulk.updatedCount,
    verifiedCount,
    verificationMode,
  };
}

export function mergeMeterSphereCaseOperationReceipts(
  receipts: MeterSphereCaseOperationReceipt[],
): MeterSphereCaseOperationReceipt | undefined {
  if (receipts.length === 0) return undefined;
  const cases = [...new Map(receipts.flatMap(receipt => receipt.cases).map(testCase => [testCase.id, testCase])).values()];
  if (cases.length === 0) return undefined;
  const modulePath = commonModulePath(receipts.map(receipt => receipt.modulePath).filter(Boolean));
  const exactModule = receipts.find(receipt => receipt.modulePath === modulePath && receipt.moduleId);
  const moduleId = exactModule?.moduleId ?? receipts.find(receipt => receipt.moduleId)?.moduleId ?? "";
  if (!moduleId) return undefined;
  return {
    moduleId,
    modulePath,
    featureName: featureNameFromPath(modulePath),
    cases,
    itemCount: cases.length,
    createdCount: Math.min(cases.length, receipts.reduce((total, receipt) => total + receipt.createdCount, 0)),
    updatedCount: Math.min(cases.length, receipts.reduce((total, receipt) => total + receipt.updatedCount, 0)),
    verifiedCount: cases.filter(testCase => testCase.verified).length,
    verificationMode: receipts.every(receipt => receipt.verificationMode === "internal_read_back")
      ? "internal_read_back"
      : "separate_read_back",
  };
}

export function extractCaseRecordsFromResult(result: unknown): MeterSphereCaseRecord[] {
  return decodedRecords(result).flatMap(record => extractCaseRecords(
    record.results ?? record.cases ?? record.items ?? record.records ?? record.list ?? record.data ?? record.result ?? record,
  ));
}

function extractCaseRecords(value: unknown): MeterSphereCaseRecord[] {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed.flatMap(item => extractCaseRecords(item));
  if (!isRecord(parsed)) return [];
  if (isCaseRecord(parsed)) {
    const id = stringValue(parsed.id ?? parsed.caseId ?? parsed.case_id);
    const numValue = parsed.num ?? parsed.case_num ?? parsed.caseNumber ?? id;
    const name = stringValue(parsed.name ?? parsed.case_name ?? parsed.caseName ?? parsed.title);
    if (!id || !name) return [];
    const mismatches = Array.isArray(parsed.mismatches) ? parsed.mismatches : [];
    const verified = booleanValue(parsed.verified) ?? mismatches.length === 0;
    return [{
      id,
      num: typeof numValue === "number" ? numValue : stringValue(numValue),
      name,
      priority: stringValue(parsed.priority ?? parsed.level).toUpperCase(),
      verified,
      ...(stringValue(parsed.node_id ?? parsed.nodeId) ? { nodeId: stringValue(parsed.node_id ?? parsed.nodeId) } : {}),
      ...(stringValue(parsed.node_path ?? parsed.nodePath) ? { nodePath: stringValue(parsed.node_path ?? parsed.nodePath) } : {}),
    }];
  }
  for (const key of ["results", "cases", "items", "records", "list", "data", "result"]) {
    if (!(key in parsed)) continue;
    const found = extractCaseRecords(parsed[key]);
    if (found.length > 0) return found;
  }
  return [];
}

function extractModuleRecords(result: unknown): MeterSphereModuleRecord[] {
  return decodedRecords(result).flatMap(record => {
    const id = stringValue(record.module_id ?? record.id);
    const path = stringValue(record.path);
    const name = stringValue(record.name);
    if (!id || !path) return [];
    return [{ id, path, name, verified: booleanValue(record.verified) ?? false }];
  });
}

function enrichCaseMetadata(
  cases: MeterSphereCaseRecord[],
  inputItems: Array<Record<string, unknown>>,
): MeterSphereCaseRecord[] {
  return cases.map(testCase => {
    let input = inputItems.find(item => stringValue(item.name) === testCase.name);
    if (!input && testCase.nodeId) {
      const sameModule = inputItems.filter(item => stringValue(item.node_id ?? item.nodeId) === testCase.nodeId);
      if (sameModule.length === 1) input = sameModule[0];
    }
    const nodeId = testCase.nodeId || stringValue(input?.node_id ?? input?.nodeId);
    const nodePath = testCase.nodePath || stringValue(input?.node_path ?? input?.nodePath);
    return {
      ...testCase,
      priority: testCase.priority || stringValue(input?.priority ?? input?.level).toUpperCase() || "P2",
      ...(nodeId ? { nodeId } : {}),
      ...(nodePath ? { nodePath } : {}),
    };
  });
}

function mergeVerifiedCases(
  verifiedCases: MeterSphereCaseRecord[],
  writtenCases: MeterSphereCaseRecord[],
): MeterSphereCaseRecord[] {
  return verifiedCases.map(testCase => {
    const written = writtenCases.find(item => item.id === testCase.id || item.name === testCase.name);
    return {
      ...testCase,
      priority: testCase.priority || written?.priority || "P2",
      ...(!testCase.nodeId && written?.nodeId ? { nodeId: written.nodeId } : {}),
      ...(!testCase.nodePath && written?.nodePath ? { nodePath: written.nodePath } : {}),
    };
  });
}

function decodedRecords(value: unknown): Array<Record<string, unknown>> {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed.flatMap(decodedRecords);
  if (!isRecord(parsed)) return [];
  if (Array.isArray(parsed.content)) {
    const decoded = parsed.content.flatMap(item => {
      if (!isRecord(item)) return [];
      return decodedRecords(item.text ?? item);
    });
    if (decoded.length > 0) return decoded;
  }
  return [parsed];
}

function parseItems(value: unknown): Array<Record<string, unknown>> {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try { return parseJson(JSON.parse(trimmed)); } catch { return value; }
}

function commonModulePath(paths: string[]): string {
  const normalized = paths.map(path => path.split("/").filter(Boolean)).filter(parts => parts.length > 0);
  if (normalized.length === 0) return "";
  const common = [...normalized[0]!];
  for (const parts of normalized.slice(1)) {
    while (common.length > 0 && !common.every((part, index) => parts[index] === part)) common.pop();
  }
  return common.length > 0 ? `/${common.join("/")}` : "";
}

function featureNameFromPath(path: string): string {
  const name = path.split("/").filter(Boolean).at(-1) ?? "MeterSphere 测试用例";
  return name.replace(/\s*新用例\s*$/u, "").trim() || name;
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function isCaseRecord(value: Record<string, unknown>): boolean {
  return Boolean(
    (value.name ?? value.case_name ?? value.caseName ?? value.title)
    && (value.id ?? value.caseId ?? value.case_id),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function integerValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
