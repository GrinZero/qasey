import { createHash, randomUUID } from "node:crypto";
import {
  buildMeterSphereCaseOperationReceipt,
  mergeMeterSphereCaseOperationReceipts,
  parseMeterSphereBulkOperation,
  type MeterSphereCaseOperationReceipt,
} from "./metersphere-receipt.ts";
import {
  buildEvidenceSnapshotHash,
  buildMeterSphereCasePlan,
  canonicalBulkWriteInput,
  canonicalSingleWriteInput,
  completeCaseOperationAgainstPlan,
  validateMeterSphereCasePlan,
  type MeterSphereCasePlan,
} from "./case-plan.ts";

export type EvidenceStatus = "in_flight" | "acquired" | "failed";

export interface EvidenceArtifactReceipt {
  status: "acquired" | "already_acquired";
  sourceKey: string;
  artifactId: string;
  contentHash: string;
  totalChars: number;
  preview?: string;
  truncated: boolean;
  instruction: string;
}

export interface EvidenceFailureReceipt {
  status: "failed";
  sourceKey: string;
  errorCode: string;
  retryable: boolean;
  attempts: number;
  message: string;
}

export interface EvidenceManifestEntry {
  sourceKey: string;
  toolName: string;
  status: EvidenceStatus;
  attempts: number;
  artifactId?: string;
  contentHash?: string;
  totalChars?: number;
  retryable?: boolean;
  errorCode?: string;
  completedAt?: number;
  startedSequence?: number;
  completedSequence?: number;
}

export interface EvidenceIterationDecision {
  madeProgress: boolean;
  noProgressStreak: number;
  shouldWarn: boolean;
  shouldStop: boolean;
}

export interface EvidenceCompletionReceipt {
  casePlanHash: string;
  write: EvidenceManifestEntry;
  verification: EvidenceManifestEntry;
  verificationMode: "internal_read_back" | "separate_read_back";
  caseOperation?: MeterSphereCaseOperationReceipt;
}

export interface EvidenceLedgerStats {
  actualExecutions: number;
  deduplicatedCalls: number;
  cachedFailures: number;
  artifactReads: number;
  artifactizedResults: number;
  totalResultChars: number;
  duplicateResultCharsAvoided: number;
}

interface EvidenceArtifact {
  id: string;
  serialized: string;
  contentHash: string;
}

interface EvidenceEntry extends EvidenceManifestEntry {
  callKey: string;
  input: unknown;
  result?: unknown;
  errorMessage?: string;
  completion: Promise<void>;
  resolveCompletion: () => void;
}

export interface EvidenceLedgerOptions {
  maxInlineChars?: number;
  previewChars?: number;
  maxArtifactChunkChars?: number;
  maxRetryableAttempts?: number;
  casePlan?: MeterSphereCasePlan;
}

export class IncompleteOutcomeError extends Error {
  readonly code = "INCOMPLETE_OUTCOME";

  constructor(message: string) {
    super(message);
    this.name = "IncompleteOutcomeError";
  }
}

export class EvidenceLedger {
  private readonly entries = new Map<string, EvidenceEntry>();
  private readonly sourceEntries = new Map<string, EvidenceEntry>();
  private readonly artifacts = new Map<string, EvidenceArtifact>();
  private readonly artifactReads = new Set<string>();
  private readonly maxInlineChars: number;
  private readonly previewChars: number;
  private readonly maxArtifactChunkChars: number;
  private readonly maxRetryableAttempts: number;
  private casePlanValue: MeterSphereCasePlan | undefined;
  private progressVersion = 0;
  private observedProgressVersion = 0;
  private noProgressStreak = 0;
  private executionSequence = 0;
  private mutationEpoch = 0;
  private readonly counters: EvidenceLedgerStats = {
    actualExecutions: 0,
    deduplicatedCalls: 0,
    cachedFailures: 0,
    artifactReads: 0,
    artifactizedResults: 0,
    totalResultChars: 0,
    duplicateResultCharsAvoided: 0,
  };

  constructor(readonly runId: string, options: EvidenceLedgerOptions = {}) {
    this.maxInlineChars = options.maxInlineChars ?? 24_000;
    this.previewChars = options.previewChars ?? 4_000;
    this.maxArtifactChunkChars = options.maxArtifactChunkChars ?? 20_000;
    this.maxRetryableAttempts = options.maxRetryableAttempts ?? 2;
    this.casePlanValue = options.casePlan ? validateMeterSphereCasePlan(options.casePlan) : undefined;
  }

  async execute(
    toolName: string,
    input: unknown,
    operation: (effectiveInput: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    input = this.validatedMutationInput(toolName, input);
    const baseCallKey = createCallKey(toolName, input);
    const callKey = isMeterSphereRead(toolName) ? `${baseCallKey}:epoch:${this.mutationEpoch}` : baseCallKey;
    const baseSourceKey = createSourceKey(toolName, input);
    const sourceKey = isMeterSphereRead(toolName) ? `${baseSourceKey}:epoch:${this.mutationEpoch}` : baseSourceKey;
    const sourceEntry = this.sourceEntries.get(sourceKey);
    const existing = this.entries.get(callKey) ?? (sourceEntry && canReuseSourceEntry(sourceEntry, toolName, input) ? sourceEntry : undefined);

    if (existing?.status === "in_flight") {
      await existing.completion;
      this.recordReplay(existing);
      return this.replay(existing);
    }
    if (existing?.status === "acquired") {
      this.recordReplay(existing);
      return this.replay(existing);
    }
    if (existing?.status === "failed" && (!existing.retryable || existing.attempts >= this.maxRetryableAttempts)) {
      this.counters.cachedFailures += 1;
      return failureReceipt(existing);
    }

    const entry = existing ?? createEntry(callKey, sourceKey, toolName, input);
    if (!existing) {
      this.entries.set(callKey, entry);
      this.sourceEntries.set(sourceKey, entry);
    }
    else resetCompletion(entry);
    entry.status = "in_flight";
    entry.attempts += 1;
    entry.startedSequence = ++this.executionSequence;
    delete entry.completedSequence;
    this.counters.actualExecutions += 1;

    try {
      const result = await operation(input);
      if (isToolErrorResult(result)) throw toolResultError(result);
      const candidatePlan = this.casePlanFromDryRun(toolName, input, result);
      if (candidatePlan) {
        if (this.casePlanValue && this.casePlanValue.planHash !== candidatePlan.planHash) {
          throw new Error("A different MeterSphere CasePlan already exists for this run");
        }
        this.casePlanValue ??= candidatePlan;
      }
      const artifact = this.storeArtifact(result);
      entry.status = "acquired";
      entry.result = result;
      entry.artifactId = artifact.id;
      entry.contentHash = artifact.contentHash;
      entry.totalChars = artifact.serialized.length;
      this.counters.totalResultChars += artifact.serialized.length;
      if (artifact.serialized.length > this.maxInlineChars) this.counters.artifactizedResults += 1;
      entry.completedAt = Date.now();
      entry.completedSequence = ++this.executionSequence;
      if (isMeterSphereMutation(toolName)) this.mutationEpoch += 1;
      delete entry.retryable;
      delete entry.errorCode;
      delete entry.errorMessage;
      if (!isOrchestrationTool(toolName)) this.progressVersion += 1;
      entry.resolveCompletion();
      return artifact.serialized.length > this.maxInlineChars
        ? artifactReceipt(entry, artifact, "acquired", this.previewChars)
        : result;
    } catch (error) {
      const classification = classifyToolError(error);
      entry.status = "failed";
      entry.retryable = classification.retryable;
      entry.errorCode = classification.code;
      entry.errorMessage = classification.message;
      entry.completedAt = Date.now();
      entry.completedSequence = ++this.executionSequence;
      if (!isOrchestrationTool(toolName)) this.progressVersion += 1;
      entry.resolveCompletion();
      return failureReceipt(entry);
    }
  }

  private validatedMutationInput(toolName: string, input: unknown): unknown {
    if (isMeterSphereBulkMutation(toolName) && isRecord(input) && input.dry_run === false) {
      if (this.casePlanValue) return canonicalBulkWriteInput(input, this.casePlanValue);
      throw new Error("A successful MeterSphere dry-run CasePlan is required before writing test cases");
    }
    if (isMeterSphereSingleCaseMutation(toolName)) {
      if (!this.casePlanValue) throw new Error("A persisted MeterSphere CasePlan is required before single-case fallback writes");
      return canonicalSingleWriteInput(toolName, input, this.casePlanValue);
    }
    return input;
  }

  private casePlanFromDryRun(toolName: string, input: unknown, result: unknown): MeterSphereCasePlan | undefined {
    if (!isMeterSphereBulkMutation(toolName) || !isRecord(input) || input.dry_run !== true) return undefined;
    return buildMeterSphereCasePlan({
      dryRunInput: input,
      dryRunResult: result,
      evidenceSnapshotHash: this.evidenceSnapshotHash(),
    });
  }

  private evidenceSnapshotHash(): string {
    return buildEvidenceSnapshotHash([...this.entries.values()]
      .filter(entry => entry.status === "acquired" && entry.contentHash && isCasePlanEvidence(entry.toolName))
      .map(entry => ({ sourceKey: entry.sourceKey, contentHash: entry.contentHash! })));
  }

  casePlan(): MeterSphereCasePlan | undefined {
    return this.casePlanValue ? structuredClone(this.casePlanValue) : undefined;
  }

  readArtifact(artifactId: string, offset = 0, maxChars = this.maxArtifactChunkChars) {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new Error(`Evidence artifact not found: ${artifactId}`);
    const safeOffset = Math.max(0, Math.min(Math.trunc(offset), artifact.serialized.length));
    const safeMaxChars = Math.max(1, Math.min(Math.trunc(maxChars), this.maxArtifactChunkChars));
    const readKey = `${artifactId}:${safeOffset}:${safeMaxChars}`;
    if (!this.artifactReads.has(readKey)) {
      this.artifactReads.add(readKey);
      this.counters.artifactReads += 1;
      this.progressVersion += 1;
    }
    const content = artifact.serialized.slice(safeOffset, safeOffset + safeMaxChars);
    const nextOffset = safeOffset + content.length;
    return {
      artifactId,
      contentHash: artifact.contentHash,
      offset: safeOffset,
      nextOffset,
      totalChars: artifact.serialized.length,
      done: nextOffset >= artifact.serialized.length,
      content,
    };
  }

  finishIteration(toolCallCount: number): EvidenceIterationDecision {
    const madeProgress = this.progressVersion > this.observedProgressVersion;
    this.observedProgressVersion = this.progressVersion;
    if (toolCallCount === 0 || madeProgress) this.noProgressStreak = 0;
    else this.noProgressStreak += 1;
    return {
      madeProgress,
      noProgressStreak: this.noProgressStreak,
      shouldWarn: toolCallCount > 0 && this.noProgressStreak === 1,
      shouldStop: toolCallCount > 0 && this.noProgressStreak >= 2,
    };
  }

  snapshot(): EvidenceManifestEntry[] {
    return [...this.entries.values()].map(entry => this.manifestEntry(entry));
  }

  private manifestEntry(entry: EvidenceEntry): EvidenceManifestEntry {
    return {
      sourceKey: entry.sourceKey,
      toolName: entry.toolName,
      status: entry.status,
      attempts: entry.attempts,
      ...(entry.artifactId ? { artifactId: entry.artifactId } : {}),
      ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
      ...(entry.totalChars !== undefined ? { totalChars: entry.totalChars } : {}),
      ...(entry.retryable !== undefined ? { retryable: entry.retryable } : {}),
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
      ...(entry.startedSequence !== undefined ? { startedSequence: entry.startedSequence } : {}),
      ...(entry.completedSequence !== undefined ? { completedSequence: entry.completedSequence } : {}),
    };
  }

  stats(): EvidenceLedgerStats {
    return { ...this.counters };
  }

  manifestText(): string {
    const entries = this.snapshot();
    if (entries.length === 0) return "Evidence ledger: no tools have completed yet.";
    const lines = entries.slice(-30).map(entry => {
      if (entry.status === "acquired") {
        return `- acquired ${entry.sourceKey} -> ${entry.artifactId} (${entry.totalChars ?? 0} chars)`;
      }
      if (entry.status === "failed") {
        return `- failed ${entry.sourceKey} (${entry.errorCode}, retryable=${String(entry.retryable)}, attempts=${entry.attempts})`;
      }
      return `- in-flight ${entry.sourceKey}`;
    });
    return [
      "Evidence ledger (authoritative for this run):",
      ...lines,
      "Do not fetch acquired sources again. Use qasey_read_evidence_artifact with the artifact id for a bounded missing slice.",
    ].join("\n");
  }

  completionReceipt(): EvidenceCompletionReceipt | undefined {
    const casePlan = this.casePlanValue;
    if (!casePlan) return undefined;
    const acquiredEntries = [...this.entries.values()].filter(entry =>
      entry.status === "acquired" && entry.completedSequence !== undefined,
    );
    const writes = acquiredEntries.filter(entry => isEffectiveMeterSphereWrite(entry));
    if (writes.length === 0) return undefined;
    const write = writes.reduce((latest, current) => current.completedSequence! > latest.completedSequence! ? current : latest);
    const moduleResults = acquiredEntries
      .filter(entry => entry.toolName.toLowerCase().includes("metersphere") && entry.toolName.toLowerCase().includes("upsert_module"))
      .map(entry => entry.result);
    const internalOperations = writes.map(entry => buildMeterSphereCaseOperationReceipt({
      writeInput: entry.input,
      writeResult: entry.result,
      moduleResults,
    })).filter((operation): operation is MeterSphereCaseOperationReceipt => Boolean(operation));
    const internalCaseOperation = buildMeterSphereCaseOperationReceipt({
      writeInput: write.input,
      writeResult: write.result,
      moduleResults,
    });
    if (internalCaseOperation?.verificationMode === "internal_read_back") {
      const completeOperation = completeCaseOperationAgainstPlan(
        casePlan,
        mergeMeterSphereCaseOperationReceipts(internalOperations) ?? internalCaseOperation,
      );
      if (!completeOperation) return undefined;
      const manifest = this.manifestEntry(write);
      return {
        casePlanHash: casePlan.planHash,
        write: manifest,
        verification: manifest,
        verificationMode: "internal_read_back",
        caseOperation: completeOperation,
      };
    }
    const verification = acquiredEntries
      .filter(entry => isMeterSphereVerification(entry.toolName) && entry.startedSequence! > write.completedSequence!)
      .sort((a, b) => a.startedSequence! - b.startedSequence!)[0];
    if (!verification) return undefined;
    const caseOperation = buildMeterSphereCaseOperationReceipt({
      writeInput: write.input,
      writeResult: write.result,
      verificationResult: verification.result,
      moduleResults,
    });
    const completeOperation = completeCaseOperationAgainstPlan(casePlan, caseOperation);
    if (!completeOperation) return undefined;
    return {
      casePlanHash: casePlan.planHash,
      write: this.manifestEntry(write),
      verification: this.manifestEntry(verification),
      verificationMode: "separate_read_back",
      caseOperation: completeOperation,
    };
  }

  private replay(entry: EvidenceEntry): unknown {
    if (entry.status === "failed") return failureReceipt(entry);
    if (!entry.artifactId || !entry.contentHash || entry.totalChars === undefined) {
      throw new Error(`Evidence entry is incomplete: ${entry.sourceKey}`);
    }
    const artifact = this.artifacts.get(entry.artifactId);
    if (!artifact) throw new Error(`Evidence artifact not found: ${entry.artifactId}`);
    return artifactReceipt(entry, artifact, "already_acquired", this.previewChars);
  }

  private recordReplay(entry: EvidenceEntry): void {
    if (entry.status === "failed") {
      this.counters.cachedFailures += 1;
      return;
    }
    this.counters.deduplicatedCalls += 1;
    this.counters.duplicateResultCharsAvoided += Math.max(0, (entry.totalChars ?? 0) - this.previewChars);
  }

  private storeArtifact(result: unknown): EvidenceArtifact {
    const serialized = safeStringify(result);
    const contentHash = createHash("sha256").update(serialized).digest("hex");
    const id = `evidence_${contentHash.slice(0, 20)}`;
    const artifact = { id, serialized, contentHash };
    this.artifacts.set(id, artifact);
    return artifact;
  }
}

export function createCallKey(toolName: string, input: unknown): string {
  return `${toolName}:${createHash("sha256").update(stableStringify(normalizeToolInput(toolName, input))).digest("hex")}`;
}

export function createSourceKey(toolName: string, input: unknown): string {
  const value = isRecord(input) ? input : {};
  const normalizedName = toolName.toLowerCase();
  if (normalizedName.includes("slack_get_thread")) {
    return `slack-thread:${stringValue(value.channel)}:${stringValue(value.threadTs ?? value.thread_ts)}`;
  }
  if (normalizedName.includes("github_get_pull_request")) {
    const suffix = normalizedName.includes("diff") ? "diff" : "metadata";
    return `github-pr-${suffix}:${stringValue(value.owner).toLowerCase()}/${stringValue(value.repo).toLowerCase()}#${stringValue(value.pullNumber ?? value.pull_number)}`;
  }
  if (normalizedName.includes("figma")) {
    const fileKey = stringValue(value.file_key ?? value.fileKey);
    const nodeIds = normalizeFigmaNodeIds(value.node_ids ?? value.nodeIds);
    return `figma:${normalizedName}:${fileKey}:${nodeIds}:${createHash("sha256").update(stableStringify(normalizeToolInput(toolName, input))).digest("hex").slice(0, 12)}`;
  }
  return `${toolName}:${createHash("sha256").update(stableStringify(normalizeToolInput(toolName, input))).digest("hex").slice(0, 20)}`;
}

export function classifyToolError(error: unknown): { code: string; retryable: boolean; message: string } {
  const candidate = isRecord(error) ? error : {};
  const status = numericValue(candidate.statusCode ?? candidate.status);
  const message = error instanceof Error ? error.message : String(error);
  const explicitCode = stringValue(candidate.code);
  if (status !== undefined) {
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return { code: `HTTP_${status}`, retryable: true, message };
    }
    return { code: `HTTP_${status}`, retryable: false, message };
  }
  if (/abort|timeout|timed out|econnreset|econnrefused|enotfound|network/i.test(`${explicitCode} ${message}`)) {
    return { code: explicitCode || "TRANSIENT_NETWORK_ERROR", retryable: true, message };
  }
  return { code: explicitCode || "TOOL_EXECUTION_ERROR", retryable: false, message };
}

export function isMeterSphereWrite(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized.includes("metersphere") && /(?:bulk_upsert|create_test_case|edit_test_case|batch_edit)/.test(normalized);
}

export function isMeterSphereVerification(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized.includes("metersphere") && /(?:list_test_cases|get_test_case_detail)/.test(normalized);
}

function isEffectiveMeterSphereWrite(entry: EvidenceEntry): boolean {
  if (!isMeterSphereWrite(entry.toolName)) return false;
  if (!entry.toolName.toLowerCase().includes("bulk_upsert_test_cases")) return true;
  const operation = parseMeterSphereBulkOperation(entry.input, entry.result);
  if (operation) return !operation.dryRun && operation.success;
  return !(isRecord(entry.input) && entry.input.dry_run === true);
}

function isMeterSphereRead(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized.includes("metersphere") && /(?:list|get)/.test(normalized);
}

function isMeterSphereMutation(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized.includes("metersphere") && /(?:create|edit|upsert|batch)/.test(normalized);
}

function isMeterSphereBulkMutation(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized.includes("metersphere") && normalized.includes("bulk_upsert_test_cases");
}

function isMeterSphereSingleCaseMutation(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized.includes("metersphere") && /(?:create_test_case|edit_test_case)/.test(normalized);
}

function isCasePlanEvidence(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return !normalized.includes("metersphere")
    && normalized !== "qasey_report_progress"
    && !isOrchestrationTool(toolName);
}

function isOrchestrationTool(toolName: string): boolean {
  return toolName === "executeTypescript" || toolName === "execute_typescript";
}

function createEntry(callKey: string, sourceKey: string, toolName: string, input: unknown): EvidenceEntry {
  let resolveCompletion: () => void = () => {};
  const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
  return { callKey, sourceKey, toolName, input, status: "in_flight", attempts: 0, completion, resolveCompletion };
}

function canReuseSourceEntry(entry: EvidenceEntry, toolName: string, input: unknown): boolean {
  if (!toolName.toLowerCase().includes("slack_get_thread")) return true;
  const previous = isRecord(entry.input) ? numericValue(entry.input.limit) ?? 100 : undefined;
  const requested = isRecord(input) ? numericValue(input.limit) ?? 100 : undefined;
  if (previous === undefined || requested === undefined) return false;
  return previous >= requested;
}

function resetCompletion(entry: EvidenceEntry): void {
  let resolveCompletion: () => void = () => {};
  entry.completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
  entry.resolveCompletion = resolveCompletion;
}

function artifactReceipt(
  entry: EvidenceEntry,
  artifact: EvidenceArtifact,
  status: EvidenceArtifactReceipt["status"],
  previewChars: number,
): EvidenceArtifactReceipt {
  const preview = extractPreview(entry.result, artifact.serialized, previewChars);
  return {
    status,
    sourceKey: entry.sourceKey,
    artifactId: artifact.id,
    contentHash: artifact.contentHash,
    totalChars: artifact.serialized.length,
    ...(preview ? { preview } : {}),
    truncated: artifact.serialized.length > previewChars,
    instruction: "Do not call the source tool again. Use qasey_read_evidence_artifact with this artifactId and a bounded offset if more detail is required.",
  };
}

function failureReceipt(entry: EvidenceEntry): EvidenceFailureReceipt {
  return {
    status: "failed",
    sourceKey: entry.sourceKey,
    errorCode: entry.errorCode ?? "TOOL_EXECUTION_ERROR",
    retryable: entry.retryable ?? false,
    attempts: entry.attempts,
    message: entry.errorMessage ?? "Tool execution failed",
  };
}

function extractPreview(result: unknown, serialized: string, previewChars: number): string {
  if (typeof result === "string") return result.slice(0, previewChars);
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = result.content
      .filter(isRecord)
      .map(item => typeof item.text === "string" ? item.text : "")
      .filter(Boolean)
      .join("\n");
    if (text) return text.slice(0, previewChars);
  }
  return serialized.slice(0, previewChars);
}

function isToolErrorResult(value: unknown): boolean {
  return isRecord(value) && value.isError === true;
}

function toolResultError(value: unknown): Error {
  const error = new Error(`Tool returned an error result: ${extractPreview(value, safeStringify(value), 1_000)}`);
  error.name = "ToolResultError";
  return error;
}

function normalizeToolInput(toolName: string, input: unknown): unknown {
  if (!isRecord(input)) return input;
  const normalized = { ...input };
  const normalizedName = toolName.toLowerCase();
  if (normalizedName.includes("slack_get_thread") && normalized.limit === undefined) normalized.limit = 100;
  if (normalizedName.includes("slack_get_history") && normalized.limit === undefined) normalized.limit = 50;
  if (normalizedName.includes("figma")) {
    if ("node_ids" in normalized) normalized.node_ids = normalizeFigmaNodeIds(normalized.node_ids);
    if ("nodeIds" in normalized) normalized.nodeIds = normalizeFigmaNodeIds(normalized.nodeIds);
  }
  return normalized;
}

function normalizeFigmaNodeIds(value: unknown): string {
  return stringValue(value)
    .split(",")
    .map(item => item.trim().replace(/^(\d+)-(\d+)$/, "$1:$2"))
    .filter(Boolean)
    .sort()
    .join(",");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ type: typeof value, unavailable: true, id: randomUUID() });
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
