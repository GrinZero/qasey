import { createHash, randomUUID } from "node:crypto";
import {
  E2EContextDraftSchema,
  E2EContextSnapshotSchema,
  E2EExecutionBriefSchema,
  TestCaseSpecSchema,
  type E2EAmendment,
  type E2EContextDraft,
  type E2EContextSnapshot,
  type E2EExecutionBrief,
  type E2ERepositoryExecution,
  type TestCaseSpec,
} from "../../contracts/src/index.ts";

const SECRET_PATTERNS = [
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/giu,
  /\b((?:token|secret|password|cookie|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu,
  /\b(gh[opsu]_[A-Za-z0-9]{20,})\b/gu,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/gu,
];

export interface E2EContextSource {
  sessionId: string;
  threadId: string;
  taskRunId: string;
  requestId: string;
  resourceId: string;
}

export function freezeE2EContext(draftInput: E2EContextDraft, source: E2EContextSource, now = new Date()): E2EContextSnapshot {
  const draft = E2EContextDraftSchema.parse(redactValue(draftInput));
  const body = { version: 1 as const, ...draft, source, createdAt: now.toISOString() };
  return E2EContextSnapshotSchema.parse({ ...body, snapshotHash: hashJson(body) });
}

export function freezeE2EExecutionBrief(input: {
  context: E2EContextSnapshot;
  cases: TestCaseSpec[];
  repository: E2ERepositoryExecution;
  now?: Date;
}): E2EExecutionBrief {
  const body = {
    version: 1 as const,
    context: E2EContextSnapshotSchema.parse(input.context),
    cases: input.cases.map(testCase => TestCaseSpecSchema.parse(redactValue(testCase))),
    repository: redactValue(input.repository),
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  return E2EExecutionBriefSchema.parse({ ...body, briefHash: hashJson(body) });
}

export function createE2EAmendment(reviewerId: string, feedbackInput: string, now = new Date()): E2EAmendment {
  const feedback = redactString(feedbackInput).trim();
  if (!feedback) throw new Error("QA amendment feedback is empty after redaction");
  const body = { id: randomUUID(), createdAt: now.toISOString(), reviewerId, feedback };
  return { ...body, hash: hashJson(body) };
}

/** Convert the deliberately loose MeterSphere MCP response into the durable E2E case contract. */
export function testCaseSpecFromMeterSphere(caseId: string, result: unknown): TestCaseSpec {
  const record = findCaseRecord(result, caseId);
  if (!record) throw new Error(`MeterSphere case ${caseId} did not return a case detail record`);
  const title = stringValue(record.name ?? record.title ?? record.case_name ?? record.caseName);
  if (!title) throw new Error(`MeterSphere case ${caseId} is missing a title`);
  const rawSteps = parseArray(record.steps ?? record.step_list ?? record.test_steps ?? record.caseSteps);
  const steps = rawSteps.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const action = stringValue(value.action ?? value.step ?? value.description ?? value.desc);
    const expectedValues = parseStringArray(value.expected ?? value.expected_result ?? value.result ?? value.expectation);
    if (!action || expectedValues.length === 0) return [];
    return [{ action: `${index + 1}. ${action}`, expected: expectedValues }];
  });
  if (steps.length === 0) throw new Error(`MeterSphere case ${caseId} has no complete action/expected steps`);
  const targetRaw = stringValue(record.target ?? record.platform ?? record.test_platform).toLowerCase();
  const target = targetRaw.includes("android") ? "android" as const : targetRaw.includes("ios") ? "ios" as const : "web" as const;
  const priorityRaw = stringValue(record.priority ?? record.level).toUpperCase();
  const priority = /^(P0|P1|P2|P3)$/u.test(priorityRaw) ? priorityRaw as "P0" | "P1" | "P2" | "P3" : "P2";
  return TestCaseSpecSchema.parse({
    id: caseId,
    ...(stringValue(record.requirement_id ?? record.requirementId) ? { requirementId: stringValue(record.requirement_id ?? record.requirementId) } : {}),
    title,
    target,
    priority,
    evidenceRefs: [{ source: "metersphere", ref: caseId }],
    preconditions: parseStringArray(record.preconditions ?? record.prerequisites ?? record.precondition),
    steps,
    testData: isRecord(record.test_data ?? record.testData) ? record.test_data ?? record.testData : {},
    tags: parseStringArray(record.tags),
    unresolvedQuestions: parseStringArray(record.unresolved_questions ?? record.unresolvedQuestions),
  });
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function redactValue<T>(value: T, key?: string): T {
  if (key && /^(?:token|secret|password|cookie|authorization|api[_-]?key)$/iu.test(key)) return "[REDACTED]" as T;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map(entry => redactValue(entry)) as T;
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redactValue(entry, entryKey)])) as T;
}

function redactString(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, (_match, prefix?: string) => `${prefix ?? ""}[REDACTED]`), value);
}

function findCaseRecord(value: unknown, caseId: string): Record<string, unknown> | undefined {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    return parsed.map(item => findCaseRecord(item, caseId)).find(Boolean);
  }
  if (!isRecord(parsed)) return undefined;
  const id = stringValue(parsed.id ?? parsed.case_id ?? parsed.caseId);
  if (id === caseId || (!id && (parsed.steps || parsed.test_steps || parsed.caseSteps))) return parsed;
  for (const key of ["result", "data", "case", "cases", "items", "records", "content"]) {
    const found = findCaseRecord(parsed[key], caseId);
    if (found) return found;
  }
  if (typeof parsed.text === "string") return findCaseRecord(parsed.text, caseId);
  return undefined;
}

function parseArray(value: unknown): unknown[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed.map(stringValue).filter(Boolean);
  const text = stringValue(parsed);
  return text ? text.split(/\r?\n|\s*[,;]\s*/u).map(item => item.trim()).filter(Boolean) : [];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/u.test(trimmed)) return value;
  try { return parseJson(JSON.parse(trimmed)); } catch { return value; }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
