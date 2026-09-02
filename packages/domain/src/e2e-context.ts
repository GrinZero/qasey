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

export function createE2EAmendment(reviewerId: string, feedbackInput: string, now = new Date(), caseVersionId?: string): E2EAmendment {
  const feedback = redactString(feedbackInput).trim();
  if (!feedback) throw new Error("QA amendment feedback is empty after redaction");
  const body = { id: randomUUID(), createdAt: now.toISOString(), reviewerId, feedback, ...(caseVersionId ? { caseVersionId } : {}) };
  return { ...body, hash: hashJson(body) };
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

function collectCaseRecords(value: unknown): Array<Record<string, unknown>> {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed.flatMap(collectCaseRecords);
  if (!isRecord(parsed)) return [];
  const current = (parsed.num !== undefined || parsed.case_num !== undefined || parsed.caseNumber !== undefined)
    ? [parsed]
    : [];
  const nested = ["result", "data", "case", "cases", "items", "records", "content", "text"]
    .flatMap(key => collectCaseRecords(parsed[key]));
  return [...current, ...nested];
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
