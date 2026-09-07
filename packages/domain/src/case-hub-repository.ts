import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  CaseHubCaseSchema,
  CaseHubCaseDetailSchema,
  CaseHubCaseVersionSchema,
  CaseHubChangeSetSchema,
  CaseReviewItemSchema,
  CaseReviewPlanSchema,
  CaseHubResultReviewInputSchema,
  CaseHubResultSchema,
  type ArtifactRef,
  type CaseHubCase,
  type CaseHubCaseDetail,
  type CaseHubCaseProposal,
  type CaseHubCaseVersion,
  type CaseHubCaseVersionPresentation,
  type CaseAutomationProjection,
  type CaseHubChangeSet,
  type CaseHubChangeSetStatus,
  type CaseHubResult,
  type CaseAutomationStatus,
  type CaseReviewContent,
  type CaseReviewItem,
  type CaseReviewPlan,
  type CaseReviewPlanDetail,
  type OwnerScope,
  type RepositoryProfile,
  type RequirementSnapshot,
  type TestCaseSpec,
} from "../../contracts/src/index.ts";
import { hashJson } from "./e2e-context.ts";

export interface CreateCaseHubChangeSetCommand {
  requirement: RequirementSnapshot;
  proposals: CaseHubCaseProposal[];
  repository: RepositoryProfile;
  createdBy: string;
  baseSha?: string;
  environmentSourceSha?: string;
}

export interface CreateCaseReviewPlanCommand {
  conversationId: string;
  threadId: string;
  subjectId: string;
  requirement: RequirementSnapshot;
  proposals: CaseReviewContent[];
  createdBy: string;
}

export interface CreateAutomationChangeSetCommand {
  requirement: RequirementSnapshot;
  caseVersionIds: string[];
  repository: RepositoryProfile;
  createdBy: string;
  baseSha?: string;
  environmentSourceSha?: string;
}

export interface CaseExecutionObservation {
  caseId: string;
  executionStatus: CaseHubResult["executionStatus"];
  durationMs?: number;
  artifactNames?: string[];
}

export type CaseHubChangeSetPatch = Partial<Pick<CaseHubChangeSet,
  "status" | "runId" | "automationPaths" | "branch" | "pullRequestUrl" | "baseSha" | "environmentSourceSha" | "error"
>>;

export interface CaseHubRepository {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  createChangeSet(owner: OwnerScope, command: CreateCaseHubChangeSetCommand): Promise<CaseHubChangeSet>;
  createReviewPlan(owner: OwnerScope, command: CreateCaseReviewPlanCommand): Promise<CaseReviewPlanDetail>;
  getReviewPlan(owner: OwnerScope, id: string, viewerId: string): Promise<CaseReviewPlanDetail | undefined>;
  listReviewPlans(owner: OwnerScope, viewerId: string, limit?: number): Promise<CaseReviewPlanDetail[]>;
  cancelReviewPlan(owner: OwnerScope, planId: string, actorId: string, expectedRevision: number): Promise<CaseReviewPlanDetail>;
  updateReviewItem(owner: OwnerScope, planId: string, itemId: string, actorId: string, expectedRevision: number, content: CaseReviewContent): Promise<CaseReviewPlanDetail>;
  setReviewItemRemoved(owner: OwnerScope, planId: string, itemId: string, actorId: string, expectedRevision: number, removed: boolean): Promise<CaseReviewPlanDetail>;
  approveReviewItems(owner: OwnerScope, planId: string, actorId: string, items: Array<{ itemId: string; expectedRevision: number }>): Promise<CaseReviewPlanDetail>;
  createAutomationChangeSet(owner: OwnerScope, command: CreateAutomationChangeSetCommand): Promise<CaseHubChangeSet>;
  automationStatuses(owner: OwnerScope, caseVersionIds: string[]): Promise<Record<string, CaseAutomationStatus>>;
  getChangeSet(owner: OwnerScope, id: string): Promise<CaseHubChangeSet | undefined>;
  listChangeSets(owner: OwnerScope, limit?: number): Promise<CaseHubChangeSet[]>;
  updateChangeSet(owner: OwnerScope, id: string, expectedRevision: number, patch: CaseHubChangeSetPatch): Promise<CaseHubChangeSet>;
  listCases(owner: OwnerScope, query?: string): Promise<CaseHubCase[]>;
  getCase(owner: OwnerScope, id: string): Promise<CaseHubCase | undefined>;
  deleteCase(owner: OwnerScope, id: string): Promise<boolean>;
  versionsForCase(owner: OwnerScope, caseId: string): Promise<CaseHubCaseVersion[]>;
  versionsForChangeSet(owner: OwnerScope, changeSetId: string): Promise<CaseHubCaseVersion[]>;
  createPendingResults(owner: OwnerScope, changeSetId: string, runId: string, artifacts?: ArtifactRef[], caseVersionIds?: string[], observations?: CaseExecutionObservation[]): Promise<CaseHubResult[]>;
  listResults(owner: OwnerScope, changeSetId: string): Promise<CaseHubResult[]>;
  getResult(owner: OwnerScope, resultId: string): Promise<CaseHubResult | undefined>;
  reviewResult(owner: OwnerScope, resultId: string, reviewerId: string, input: unknown): Promise<CaseHubResult>;
  finalizeApprovedCaseIds(owner: OwnerScope, changeSetId: string): Promise<CaseHubChangeSet>;
  activateApprovedVersions(owner: OwnerScope, changeSetId: string): Promise<void>;
  close?(): Promise<void>;
}

export class CaseHubRevisionConflictError extends Error {
  readonly code = "case_hub_revision_conflict";
  constructor(readonly changeSetId: string) {
    super(`Case Hub change set ${changeSetId} revision conflict`);
  }
}

export class CaseHubCaseSequenceConflictError extends Error {
  readonly code = "case_hub_case_sequence_conflict";
  constructor(readonly changeSetId: string, readonly expected: number, readonly actual: number) {
    super(`Case Hub change set ${changeSetId} used candidate Case sequence ${expected}, but the next approved sequence is ${actual}; regenerate the Change Set`);
  }
}

export class CaseReviewRevisionConflictError extends Error {
  readonly code = "case_review_revision_conflict";
  constructor(readonly itemId: string) { super(`Case review item ${itemId} revision conflict`); }
}

export class CaseReviewForbiddenError extends Error {
  readonly code = "case_review_forbidden";
  constructor() { super("Only the user who created this AI session can change its review plan"); }
}

export class InMemoryCaseHubRepository implements CaseHubRepository {
  private readonly cases = new Map<string, CaseHubCase>();
  private readonly deletedCases = new Set<string>();
  private readonly versions = new Map<string, CaseHubCaseVersion>();
  private readonly changeSets = new Map<string, CaseHubChangeSet>();
  private readonly results = new Map<string, CaseHubResult>();
  private readonly reviewPlans = new Map<string, CaseReviewPlan>();
  private readonly reviewItems = new Map<string, CaseReviewItem>();
  private readonly sequences = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}
  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async createReviewPlan(owner: OwnerScope, command: CreateCaseReviewPlanCommand): Promise<CaseReviewPlanDetail> {
    if (command.requirement.blockingQuestions.length > 0) throw new Error("Resolve blocking questions before creating a Case Review Plan");
    const timestamp = this.now().toISOString();
    const plan = CaseReviewPlanSchema.parse({
      ...owner, id: randomUUID(), conversationId: command.conversationId, threadId: command.threadId,
      subjectId: command.subjectId, requirement: command.requirement, status: "reviewing", revision: 1,
      createdBy: command.createdBy, createdAt: timestamp, updatedAt: timestamp,
    });
    this.reviewPlans.set(ownerKey(owner, plan.id), plan);
    command.proposals.forEach((content, ordinal) => {
      const item = CaseReviewItemSchema.parse({
        ...owner, id: randomUUID(), planId: plan.id, ordinal, revision: 1, status: "pending",
        content, createdAt: timestamp, updatedAt: timestamp,
      });
      this.reviewItems.set(ownerKey(owner, item.id), item);
    });
    return this.reviewDetail(owner, plan, command.createdBy);
  }

  async getReviewPlan(owner: OwnerScope, id: string, viewerId: string): Promise<CaseReviewPlanDetail | undefined> {
    const plan = this.reviewPlans.get(ownerKey(owner, id));
    return plan ? this.reviewDetail(owner, plan, viewerId) : undefined;
  }

  async listReviewPlans(owner: OwnerScope, viewerId: string, limit = 100): Promise<CaseReviewPlanDetail[]> {
    const plans = [...this.reviewPlans.entries()].filter(([key]) => key.startsWith(ownerPrefix(owner)))
      .map(([, plan]) => plan).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, boundedLimit(limit));
    return Promise.all(plans.map(plan => this.reviewDetail(owner, plan, viewerId)));
  }

  async cancelReviewPlan(owner: OwnerScope, planId: string, actorId: string, expectedRevision: number): Promise<CaseReviewPlanDetail> {
    const plan = this.reviewPlans.get(ownerKey(owner, planId));
    if (!plan) throw new Error("Case review plan not found");
    const detail = this.reviewDetail(owner, plan, actorId);
    if (plan.subjectId !== actorId || plan.createdBy !== actorId) throw new CaseReviewForbiddenError();
    if (plan.status === "cancelled") return detail;
    if (plan.revision !== expectedRevision) throw new CaseReviewRevisionConflictError(planId);
    const updated = CaseReviewPlanSchema.parse({ ...plan, status: "cancelled", revision: plan.revision + 1, updatedAt: this.now().toISOString() });
    this.reviewPlans.set(ownerKey(owner, planId), updated);
    return this.reviewDetail(owner, updated, actorId);
  }

  async updateReviewItem(owner: OwnerScope, planId: string, itemId: string, actorId: string, expectedRevision: number, content: CaseReviewContent): Promise<CaseReviewPlanDetail> {
    const { plan, item } = this.mutableReviewItem(owner, planId, itemId, actorId, expectedRevision);
    if (item.status === "removed") throw new Error("Restore a removed review item before editing it");
    const timestamp = this.now().toISOString();
    this.reviewItems.set(ownerKey(owner, item.id), CaseReviewItemSchema.parse({
      ...item, content, status: "pending", removedFrom: undefined, removedAt: undefined,
      approvedBy: undefined, approvedAt: undefined, revision: item.revision + 1, updatedAt: timestamp,
    }));
    return this.touchReviewPlan(owner, plan, actorId);
  }

  async setReviewItemRemoved(owner: OwnerScope, planId: string, itemId: string, actorId: string, expectedRevision: number, removed: boolean): Promise<CaseReviewPlanDetail> {
    const { plan, item } = this.mutableReviewItem(owner, planId, itemId, actorId, expectedRevision);
    if (removed && item.status === "removed") return this.reviewDetail(owner, plan, actorId);
    if (!removed && item.status !== "removed") return this.reviewDetail(owner, plan, actorId);
    const timestamp = this.now().toISOString();
    this.reviewItems.set(ownerKey(owner, item.id), CaseReviewItemSchema.parse(removed ? {
      ...item, status: "removed", removedFrom: item.status, removedAt: timestamp, revision: item.revision + 1, updatedAt: timestamp,
    } : {
      ...item, status: item.removedFrom ?? "pending", removedFrom: undefined, removedAt: undefined,
      revision: item.revision + 1, updatedAt: timestamp,
    }));
    return this.touchReviewPlan(owner, plan, actorId);
  }

  async approveReviewItems(owner: OwnerScope, planId: string, actorId: string, requested: Array<{ itemId: string; expectedRevision: number }>): Promise<CaseReviewPlanDetail> {
    const plan = this.reviewPlans.get(ownerKey(owner, planId));
    if (!plan) throw new Error(`Case Review Plan ${planId} not found`);
    this.assertReviewOwner(plan, actorId);
    const uniqueIds = new Set(requested.map(item => item.itemId));
    if (uniqueIds.size !== requested.length) throw new Error("Review items must be unique");
    const items = requested.map(reference => {
      const item = this.reviewItems.get(ownerKey(owner, reference.itemId));
      if (!item || item.planId !== planId) throw new Error(`Case review item ${reference.itemId} not found`);
      if (item.revision !== reference.expectedRevision) throw new CaseReviewRevisionConflictError(item.id);
      if (item.status !== "pending") throw new Error(`Case review item ${item.id} is not pending`);
      return item;
    });
    let nextSequence = this.nextCommittedCaseSequence(owner);
    const prepared = items.map(item => {
      const caseId = item.publishedCaseId ?? item.content.caseId ?? `QASEY-${nextSequence++}`;
      const existing = this.cases.get(ownerKey(owner, caseId));
      if (item.content.operation === "update" && !existing?.activeVersionId) throw new Error(`Case ${caseId} not found`);
      const versions = [...this.versions.values()].filter(version => version.applicationId === owner.applicationId && version.tenantId === owner.tenantId && version.caseId === caseId);
      return { item, caseId, version: Math.max(0, ...versions.map(version => version.version)) + 1 };
    });
    const timestamp = this.now().toISOString();
    for (const entry of prepared) {
      const { operation: _operation, caseId: _requestedCaseId, ...business } = entry.item.content;
      const content = { ...business, caseId: entry.caseId, projectCode: "QASEY" as const, version: entry.version, target: "web" as const };
      const version = CaseHubCaseVersionSchema.parse({
        ...owner, ...content, id: randomUUID(), evidenceRefs: plan.requirement.evidenceRefs,
        requirementSnapshotHash: plan.requirement.snapshotHash, contentHash: hashJson(content), status: "active",
        createdBy: actorId, createdAt: timestamp, automationStatus: entry.item.publishedCaseVersionId ? "stale" : "none", systemTags: [],
      });
      this.versions.set(ownerKey(owner, version.id), version);
      const existing = this.cases.get(ownerKey(owner, entry.caseId));
      this.cases.set(ownerKey(owner, entry.caseId), CaseHubCaseSchema.parse(existing ? {
        ...existing, activeVersionId: version.id, title: version.title, suitePath: version.suitePath,
        proposedVersionIds: existing.proposedVersionIds.filter(id => id !== version.id), updatedAt: timestamp,
      } : {
        ...owner, id: entry.caseId, projectCode: "QASEY", suitePath: version.suitePath, title: version.title,
        activeVersionId: version.id, proposedVersionIds: [], createdAt: timestamp, updatedAt: timestamp,
      }));
      this.reviewItems.set(ownerKey(owner, entry.item.id), CaseReviewItemSchema.parse({
        ...entry.item, status: "approved", publishedCaseId: version.caseId, publishedCaseVersionId: version.id,
        approvedBy: actorId, approvedAt: timestamp, revision: entry.item.revision + 1, updatedAt: timestamp,
      }));
    }
    this.sequences.set(this.sequenceKey(owner), nextSequence);
    return this.touchReviewPlan(owner, plan, actorId);
  }

  async createAutomationChangeSet(owner: OwnerScope, command: CreateAutomationChangeSetCommand): Promise<CaseHubChangeSet> {
    const selected = command.caseVersionIds.map(id => this.versions.get(ownerKey(owner, id)));
    if (selected.some(version => !version || version.status !== "active")) throw new Error("E2E requires active approved Case Versions");
    for (const version of selected) {
      const record = this.cases.get(ownerKey(owner, version!.caseId));
      if (this.deletedCases.has(ownerKey(owner, version!.caseId)) || record?.activeVersionId !== version!.id) throw new Error(`Case Version ${version!.id} is stale`);
    }
    const timestamp = this.now().toISOString();
    const changeSet = CaseHubChangeSetSchema.parse({
      ...owner, id: randomUUID(), projectCode: "QASEY", requirement: command.requirement,
      caseVersionIds: [...new Set(command.caseVersionIds)], caseIdsFinalized: true,
      planHash: hashJson(command.caseVersionIds), status: "authoring", revision: 1, repository: command.repository,
      ...(command.baseSha ? { baseSha: command.baseSha } : {}),
      ...(command.environmentSourceSha ? { environmentSourceSha: command.environmentSourceSha } : {}),
      createdBy: command.createdBy, createdAt: timestamp, updatedAt: timestamp,
    });
    this.changeSets.set(ownerKey(owner, changeSet.id), changeSet);
    return structuredClone(changeSet);
  }

  async automationStatuses(owner: OwnerScope, caseVersionIds: string[]): Promise<Record<string, CaseAutomationStatus>> {
    return Object.fromEntries(await Promise.all(caseVersionIds.map(async id => [id, await this.automationStatus(owner, id)] as const)));
  }

  async createChangeSet(owner: OwnerScope, command: CreateCaseHubChangeSetCommand): Promise<CaseHubChangeSet> {
    const changeSetId = randomUUID();
    const candidateStart = this.nextCommittedCaseSequence(owner);
    let candidateSequence = candidateStart;
    const versions = command.proposals.map(proposal => this.buildVersion(
      owner,
      changeSetId,
      command,
      proposal,
      proposal.caseId ?? `QASEY-${candidateSequence++}`,
    ));
    const now = this.now().toISOString();
    const changeSet = CaseHubChangeSetSchema.parse({
      ...owner,
      id: changeSetId,
      projectCode: "QASEY",
      requirement: command.requirement,
      caseVersionIds: versions.map(version => version.id),
      ...(candidateSequence > candidateStart ? {
        candidateCaseSequenceRange: { start: candidateStart, end: candidateSequence - 1 },
      } : {}),
      caseIdsFinalized: candidateSequence === candidateStart,
      planHash: hashJson(versions.map(version => ({ caseId: version.caseId, contentHash: version.contentHash }))),
      status: "authoring",
      revision: 1,
      repository: command.repository,
      ...(command.baseSha ? { baseSha: command.baseSha } : {}),
      ...(command.environmentSourceSha ? { environmentSourceSha: command.environmentSourceSha } : {}),
      createdBy: command.createdBy,
      createdAt: now,
      updatedAt: now,
    });
    this.changeSets.set(ownerKey(owner, changeSet.id), changeSet);
    for (const version of versions) this.persistVersion(owner, version, now);
    return structuredClone(changeSet);
  }

  async getChangeSet(owner: OwnerScope, id: string): Promise<CaseHubChangeSet | undefined> {
    return clone(this.changeSets.get(ownerKey(owner, id)));
  }

  async listChangeSets(owner: OwnerScope, limit = 100): Promise<CaseHubChangeSet[]> {
    return [...this.changeSets.entries()]
      .filter(([key]) => key.startsWith(ownerPrefix(owner)))
      .map(([, value]) => structuredClone(value))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedLimit(limit));
  }

  async updateChangeSet(owner: OwnerScope, id: string, expectedRevision: number, patch: CaseHubChangeSetPatch): Promise<CaseHubChangeSet> {
    const key = ownerKey(owner, id);
    const current = this.changeSets.get(key);
    if (!current) throw new Error(`Case Hub change set ${id} not found`);
    if (current.revision !== expectedRevision) throw new CaseHubRevisionConflictError(id);
    assertChangeSetTransition(current.status, patch.status);
    const updated = CaseHubChangeSetSchema.parse({
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
    });
    this.changeSets.set(key, updated);
    return structuredClone(updated);
  }

  async listCases(owner: OwnerScope, query = ""): Promise<CaseHubCase[]> {
    const normalized = query.trim().toLowerCase();
    const cases = [...this.cases.entries()]
      .filter(([key]) => key.startsWith(ownerPrefix(owner)) && !this.deletedCases.has(key))
      .map(([, value]) => structuredClone(value))
      .filter(value => Boolean(value.activeVersionId))
      .filter(value => !normalized || `${value.id} ${value.title} ${value.suitePath}`.toLowerCase().includes(normalized))
      .sort((left, right) => caseSequence(left.id) - caseSequence(right.id));
    return Promise.all(cases.map(async value => {
      const automationStatus = await this.automationStatus(owner, value.activeVersionId!);
      return CaseHubCaseSchema.parse({ ...value, automationStatus, systemTags: automationStatus === "verified" ? ["e2e"] : [] });
    }));
  }

  async getCase(owner: OwnerScope, id: string): Promise<CaseHubCase | undefined> {
    if (this.deletedCases.has(ownerKey(owner, id))) return undefined;
    return clone(this.cases.get(ownerKey(owner, id)));
  }

  async deleteCase(owner: OwnerScope, id: string): Promise<boolean> {
    const key = ownerKey(owner, id);
    if (!this.cases.get(key)?.activeVersionId) return false;
    this.deletedCases.add(key);
    return true;
  }

  async versionsForCase(owner: OwnerScope, caseId: string): Promise<CaseHubCaseVersion[]> {
    return this.listVersions(owner, version => version.caseId === caseId);
  }

  async versionsForChangeSet(owner: OwnerScope, changeSetId: string): Promise<CaseHubCaseVersion[]> {
    const changeSet = await this.getChangeSet(owner, changeSetId);
    if (!changeSet) return [];
    const ids = new Set(changeSet.caseVersionIds);
    return this.listVersions(owner, version => ids.has(version.id));
  }

  async createPendingResults(owner: OwnerScope, changeSetId: string, runId: string, artifacts: ArtifactRef[] = [], caseVersionIds?: string[], observations: CaseExecutionObservation[] = []): Promise<CaseHubResult[]> {
    const selected = caseVersionIds ? new Set(caseVersionIds) : undefined;
    const versions = (await this.versionsForChangeSet(owner, changeSetId)).filter(version => !selected || selected.has(version.id));
    const existing = await this.listResults(owner, changeSetId);
    const created = versions.map(version => {
      if (version.status !== "active") this.versions.set(ownerKey(owner, version.id), CaseHubCaseVersionSchema.parse({ ...version, status: "proposed" }));
      const attempt = Math.max(0, ...existing.filter(result => result.caseVersionId === version.id).map(result => result.attempt)) + 1;
      const observation = observations.find(item => item.caseId === version.caseId);
      const result = CaseHubResultSchema.parse({
        ...owner, id: randomUUID(), changeSetId, runId, caseVersionId: version.id, caseId: version.caseId,
        attempt, executionStatus: observation?.executionStatus ?? "passed", reviewStatus: "pending", artifacts: artifactsForCase(artifacts, version.caseId, observation?.artifactNames),
        ...(observation?.durationMs !== undefined ? { durationMs: observation.durationMs } : {}),
        ...(artifacts.find(artifact => artifact.kind === "patch")?.sha256 ? { testCodeHash: artifacts.find(artifact => artifact.kind === "patch")!.sha256 } : {}),
        createdAt: this.now().toISOString(),
      });
      this.results.set(ownerKey(owner, result.id), result);
      return structuredClone(result);
    });
    return created;
  }

  async listResults(owner: OwnerScope, changeSetId: string): Promise<CaseHubResult[]> {
    return [...this.results.entries()]
      .filter(([key, result]) => key.startsWith(ownerPrefix(owner)) && result.changeSetId === changeSetId)
      .map(([, result]) => structuredClone(result))
      .sort((left, right) => left.caseId.localeCompare(right.caseId) || left.attempt - right.attempt);
  }

  async getResult(owner: OwnerScope, resultId: string): Promise<CaseHubResult | undefined> {
    return clone(this.results.get(ownerKey(owner, resultId)));
  }

  async reviewResult(owner: OwnerScope, resultId: string, reviewerId: string, input: unknown): Promise<CaseHubResult> {
    const review = CaseHubResultReviewInputSchema.parse(input);
    const key = ownerKey(owner, resultId);
    const current = this.results.get(key);
    if (!current) throw new Error(`Case Hub result ${resultId} not found`);
    const requestedStatus = reviewStatusForVerdict(review.verdict);
    if (current.reviewStatus !== "pending") {
      if (isSameReview(current, reviewerId, requestedStatus, review.feedback)) return structuredClone(current);
      throw new Error("Only pending results can be reviewed");
    }
    if (review.verdict === "approve" && current.executionStatus !== "passed") {
      throw new Error("Only passed results can be approved");
    }
    if (review.verdict === "approve" && !current.artifacts.some(isQaReviewArtifact)) {
      throw new Error("A video or Playwright trace is required before approval");
    }
    const updated = CaseHubResultSchema.parse({
      ...current, reviewStatus: requestedStatus, reviewerId, ...(review.feedback ? { feedback: review.feedback } : {}), reviewedAt: this.now().toISOString(),
    });
    this.results.set(key, updated);
    if (updated.reviewStatus === "approved") {
      const versionKey = ownerKey(owner, updated.caseVersionId);
      const version = this.versions.get(versionKey);
      if (version?.status === "proposed") this.versions.set(versionKey, CaseHubCaseVersionSchema.parse({ ...version, status: "approved" }));
    }
    return structuredClone(updated);
  }

  async finalizeApprovedCaseIds(owner: OwnerScope, changeSetId: string): Promise<CaseHubChangeSet> {
    const key = ownerKey(owner, changeSetId);
    const changeSet = this.changeSets.get(key);
    if (!changeSet) throw new Error(`Case Hub change set ${changeSetId} not found`);
    if (changeSet.caseIdsFinalized) return structuredClone(changeSet);
    await this.assertEveryVersionApproved(owner, changeSet);
    const range = changeSet.candidateCaseSequenceRange;
    if (!range) throw new Error(`Case Hub change set ${changeSetId} has no candidate Case sequence range`);
    const next = this.nextCommittedCaseSequence(owner);
    if (next !== range.start) throw new CaseHubCaseSequenceConflictError(changeSetId, range.start, next);
    this.sequences.set(this.sequenceKey(owner), range.end + 1);
    const updated = CaseHubChangeSetSchema.parse({
      ...changeSet,
      caseIdsFinalized: true,
      revision: changeSet.revision + 1,
      updatedAt: this.now().toISOString(),
    });
    this.changeSets.set(key, updated);
    return structuredClone(updated);
  }

  async activateApprovedVersions(owner: OwnerScope, changeSetId: string): Promise<void> {
    const [versions, results] = await Promise.all([this.versionsForChangeSet(owner, changeSetId), this.listResults(owner, changeSetId)]);
    for (const version of versions) {
      const latest = results.filter(result => result.caseVersionId === version.id).at(-1);
      if (latest?.reviewStatus !== "approved") throw new Error(`Case ${version.caseId} is not approved`);
      const caseRecord = this.cases.get(ownerKey(owner, version.caseId));
      if (!caseRecord) throw new Error(`Case ${version.caseId} not found`);
      // New review-gated versions are already active. The compatibility path
      // below only activates legacy proposed versions.
      if (version.status === "active" && caseRecord.activeVersionId === version.id) continue;
      const active = CaseHubCaseVersionSchema.parse({ ...version, status: "active" });
      this.versions.set(ownerKey(owner, version.id), active);
      this.cases.set(ownerKey(owner, version.caseId), CaseHubCaseSchema.parse({
        ...caseRecord, activeVersionId: version.id, proposedVersionIds: caseRecord.proposedVersionIds.filter(id => id !== version.id),
        title: version.title, suitePath: version.suitePath, updatedAt: this.now().toISOString(),
      }));
    }
  }

  async close(): Promise<void> {}

  private reviewDetail(owner: OwnerScope, plan: CaseReviewPlan, viewerId: string): CaseReviewPlanDetail {
    const items = [...this.reviewItems.entries()]
      .filter(([key, item]) => key.startsWith(ownerPrefix(owner)) && item.planId === plan.id)
      .map(([, item]) => structuredClone(item)).sort((left, right) => left.ordinal - right.ordinal);
    return { plan: structuredClone(plan), items, editable: plan.subjectId === viewerId && plan.status !== "cancelled" };
  }

  private mutableReviewItem(owner: OwnerScope, planId: string, itemId: string, actorId: string, expectedRevision: number): { plan: CaseReviewPlan; item: CaseReviewItem } {
    const plan = this.reviewPlans.get(ownerKey(owner, planId));
    if (!plan) throw new Error(`Case Review Plan ${planId} not found`);
    this.assertReviewOwner(plan, actorId);
    const item = this.reviewItems.get(ownerKey(owner, itemId));
    if (!item || item.planId !== planId) throw new Error(`Case review item ${itemId} not found`);
    if (item.revision !== expectedRevision) throw new CaseReviewRevisionConflictError(item.id);
    return { plan, item };
  }

  private assertReviewOwner(plan: CaseReviewPlan, actorId: string): void {
    if (plan.subjectId !== actorId || plan.createdBy !== actorId) throw new CaseReviewForbiddenError();
    if (plan.status === "cancelled") throw new Error("Cancelled Case Review Plans cannot be changed");
  }

  private touchReviewPlan(owner: OwnerScope, plan: CaseReviewPlan, viewerId: string): CaseReviewPlanDetail {
    const detail = this.reviewDetail(owner, plan, viewerId);
    const status = detail.items.every(item => item.status !== "pending") ? "ready" : "reviewing";
    const updated = CaseReviewPlanSchema.parse({ ...plan, status, revision: plan.revision + 1, updatedAt: this.now().toISOString() });
    this.reviewPlans.set(ownerKey(owner, plan.id), updated);
    return this.reviewDetail(owner, updated, viewerId);
  }

  private async automationStatus(owner: OwnerScope, versionId: string): Promise<CaseAutomationStatus> {
    const changeSets = (await this.listChangeSets(owner, 500))
      .filter(changeSet => changeSet.caseVersionIds.includes(versionId))
      .sort(compareChangeSetRecency);
    for (const changeSet of changeSets) {
      const status = automationStatusForChangeSet(changeSet, latestResultForVersion(await this.listResults(owner, changeSet.id), versionId));
      if (status !== "none") return status;
    }
    const version = this.versions.get(ownerKey(owner, versionId));
    const caseRecord = version ? this.cases.get(ownerKey(owner, version.caseId)) : undefined;
    if (version && caseRecord?.activeVersionId === versionId) {
      const older = [...this.versions.values()].filter(candidate => candidate.applicationId === owner.applicationId && candidate.tenantId === owner.tenantId && candidate.caseId === version.caseId && candidate.id !== versionId);
      for (const candidate of older) if (await this.automationStatus(owner, candidate.id) === "verified") return "stale";
    }
    return "none";
  }

  private buildVersion(owner: OwnerScope, changeSetId: string, command: CreateCaseHubChangeSetCommand, proposal: CaseHubCaseProposal, caseId: string): CaseHubCaseVersion {
    const currentVersions = [...this.versions.values()].filter(version => version.applicationId === owner.applicationId && version.tenantId === owner.tenantId && version.caseId === caseId);
    if (proposal.operation === "update" && currentVersions.length === 0) throw new Error(`Case ${caseId} not found`);
    const version = Math.max(0, ...currentVersions.map(item => item.version)) + 1;
    const { operation: _operation, ...caseContent } = proposal;
    const content = { ...caseContent, caseId, projectCode: "QASEY" as const, version, target: "web" as const };
    return CaseHubCaseVersionSchema.parse({
      ...owner, ...content, id: randomUUID(), evidenceRefs: proposal.evidenceRefs,
      requirementSnapshotHash: command.requirement.snapshotHash,
      contentHash: hashJson(content), status: "proposed", createdBy: command.createdBy,
      createdAt: this.now().toISOString(),
    });
  }

  private persistVersion(owner: OwnerScope, version: CaseHubCaseVersion, now: string): void {
    this.versions.set(ownerKey(owner, version.id), version);
    const existing = this.cases.get(ownerKey(owner, version.caseId));
    this.cases.set(ownerKey(owner, version.caseId), CaseHubCaseSchema.parse(existing ? {
      ...existing,
      ...(existing.activeVersionId ? {} : { title: version.title, suitePath: version.suitePath }),
      proposedVersionIds: [...existing.proposedVersionIds, version.id], updatedAt: now,
    } : {
      ...owner, id: version.caseId, projectCode: "QASEY", suitePath: version.suitePath,
      title: version.title, proposedVersionIds: [version.id], createdAt: now, updatedAt: now,
    }));
  }

  private listVersions(owner: OwnerScope, predicate: (version: CaseHubCaseVersion) => boolean): CaseHubCaseVersion[] {
    return [...this.versions.entries()]
      .filter(([key, version]) => key.startsWith(ownerPrefix(owner)) && predicate(version))
      .map(([, version]) => structuredClone(version))
      .sort((left, right) => left.version - right.version);
  }

  private nextCommittedCaseSequence(owner: OwnerScope): number {
    return this.sequences.get(this.sequenceKey(owner)) ?? 1;
  }

  private sequenceKey(owner: OwnerScope): string {
    return `${ownerPrefix(owner)}QASEY`;
  }

  private async assertEveryVersionApproved(owner: OwnerScope, changeSet: CaseHubChangeSet): Promise<void> {
    const results = await this.listResults(owner, changeSet.id);
    for (const versionId of changeSet.caseVersionIds) {
      const latest = results.filter(result => result.caseVersionId === versionId).at(-1);
      if (latest?.reviewStatus !== "approved") throw new Error(`Case Version ${versionId} is not approved`);
    }
  }
}

export class PrismaCaseHubRepository implements CaseHubRepository {
  private initialized?: Promise<void>;
  constructor(private readonly prisma: PrismaClient, private readonly now: () => Date = () => new Date()) {}
  init(): Promise<void> { this.initialized ??= this.prisma.$connect(); return this.initialized; }
  private ready(): Promise<void> { return this.initialized ?? Promise.reject(new Error("PrismaCaseHubRepository has not been initialized")); }
  async healthCheck(): Promise<void> { await this.ready(); await this.prisma.$queryRaw`SELECT 1`; }

  async createReviewPlan(owner: OwnerScope, command: CreateCaseReviewPlanCommand): Promise<CaseReviewPlanDetail> {
    await this.ready();
    if (command.requirement.blockingQuestions.length > 0) throw new Error("Resolve blocking questions before creating a Case Review Plan");
    const timestamp = this.now().toISOString();
    const plan = CaseReviewPlanSchema.parse({
      ...owner, id: randomUUID(), conversationId: command.conversationId, threadId: command.threadId,
      subjectId: command.subjectId, requirement: command.requirement, status: "reviewing", revision: 1,
      createdBy: command.createdBy, createdAt: timestamp, updatedAt: timestamp,
    });
    const items = command.proposals.map((content, ordinal) => CaseReviewItemSchema.parse({
      ...owner, id: randomUUID(), planId: plan.id, ordinal, revision: 1, status: "pending", content,
      createdAt: timestamp, updatedAt: timestamp,
    }));
    await this.prisma.$transaction(async transaction => {
      await transaction.qaseyCaseReviewPlanRecord.create({ data: {
        ...owner, id: plan.id, conversationId: plan.conversationId, threadId: plan.threadId, subjectId: plan.subjectId,
        status: plan.status, revision: plan.revision, payload: plan as unknown as Prisma.InputJsonValue,
      } });
      await transaction.qaseyCaseReviewItemRecord.createMany({ data: items.map(item => ({
        ...owner, id: item.id, planId: item.planId, ordinal: item.ordinal, status: item.status,
        revision: item.revision, payload: item as unknown as Prisma.InputJsonValue,
      })) });
    });
    return { plan, items, editable: true };
  }

  async getReviewPlan(owner: OwnerScope, id: string, viewerId: string): Promise<CaseReviewPlanDetail | undefined> {
    await this.ready();
    const row = await this.prisma.qaseyCaseReviewPlanRecord.findUnique({
      where: { applicationId_tenantId_id: { ...owner, id } }, select: { payload: true, revision: true },
    });
    if (!row) return undefined;
    const plan = CaseReviewPlanSchema.parse({ ...(row.payload as object), revision: row.revision });
    const itemRows = await this.prisma.qaseyCaseReviewItemRecord.findMany({
      where: { ...owner, planId: id }, orderBy: { ordinal: "asc" }, select: { payload: true, revision: true },
    });
    return {
      plan,
      items: itemRows.map(item => CaseReviewItemSchema.parse({ ...(item.payload as object), revision: item.revision })),
      editable: plan.subjectId === viewerId && plan.status !== "cancelled",
    };
  }

  async listReviewPlans(owner: OwnerScope, viewerId: string, limit = 100): Promise<CaseReviewPlanDetail[]> {
    await this.ready();
    const rows = await this.prisma.qaseyCaseReviewPlanRecord.findMany({
      where: owner, orderBy: { updatedAt: "desc" }, take: boundedLimit(limit), select: { id: true },
    });
    return (await Promise.all(rows.map(row => this.getReviewPlan(owner, row.id, viewerId)))).filter((value): value is CaseReviewPlanDetail => Boolean(value));
  }

  async cancelReviewPlan(owner: OwnerScope, planId: string, actorId: string, expectedRevision: number): Promise<CaseReviewPlanDetail> {
    const detail = await this.getReviewPlan(owner, planId, actorId);
    if (!detail) throw new Error("Case review plan not found");
    const { plan } = detail;
    if (plan.subjectId !== actorId || plan.createdBy !== actorId) throw new CaseReviewForbiddenError();
    if (plan.status === "cancelled") return detail;
    if (plan.revision !== expectedRevision) throw new CaseReviewRevisionConflictError(planId);
    const updated = CaseReviewPlanSchema.parse({ ...plan, status: "cancelled", revision: plan.revision + 1, updatedAt: this.now().toISOString() });
    const saved = await this.prisma.qaseyCaseReviewPlanRecord.updateMany({
      where: { ...owner, id: planId, revision: expectedRevision },
      data: { status: updated.status, revision: { increment: 1 }, payload: updated as unknown as Prisma.InputJsonValue },
    });
    if (saved.count !== 1) throw new CaseReviewRevisionConflictError(planId);
    return (await this.getReviewPlan(owner, planId, actorId))!;
  }

  async updateReviewItem(owner: OwnerScope, planId: string, itemId: string, actorId: string, expectedRevision: number, content: CaseReviewContent): Promise<CaseReviewPlanDetail> {
    await this.ready();
    await this.prisma.$transaction(async transaction => {
      const { plan, item } = await prismaMutableReviewItem(transaction, owner, planId, itemId, actorId, expectedRevision);
      if (item.status === "removed") throw new Error("Restore a removed review item before editing it");
      const timestamp = this.now().toISOString();
      const updated = CaseReviewItemSchema.parse({
        ...item, content, status: "pending", removedFrom: undefined, removedAt: undefined,
        approvedBy: undefined, approvedAt: undefined, revision: item.revision + 1, updatedAt: timestamp,
      });
      const saved = await transaction.qaseyCaseReviewItemRecord.updateMany({
        where: { ...owner, id: itemId, planId, revision: expectedRevision },
        data: { status: updated.status, revision: { increment: 1 }, payload: updated as unknown as Prisma.InputJsonValue },
      });
      if (saved.count !== 1) throw new CaseReviewRevisionConflictError(itemId);
      await prismaTouchReviewPlan(transaction, owner, plan, timestamp);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return (await this.getReviewPlan(owner, planId, actorId))!;
  }

  async setReviewItemRemoved(owner: OwnerScope, planId: string, itemId: string, actorId: string, expectedRevision: number, removed: boolean): Promise<CaseReviewPlanDetail> {
    await this.ready();
    await this.prisma.$transaction(async transaction => {
      const { plan, item } = await prismaMutableReviewItem(transaction, owner, planId, itemId, actorId, expectedRevision);
      if (removed === (item.status === "removed")) return;
      const timestamp = this.now().toISOString();
      const updated = CaseReviewItemSchema.parse(removed ? {
        ...item, status: "removed", removedFrom: item.status, removedAt: timestamp,
        revision: item.revision + 1, updatedAt: timestamp,
      } : {
        ...item, status: item.removedFrom ?? "pending", removedFrom: undefined, removedAt: undefined,
        revision: item.revision + 1, updatedAt: timestamp,
      });
      const saved = await transaction.qaseyCaseReviewItemRecord.updateMany({
        where: { ...owner, id: itemId, planId, revision: expectedRevision },
        data: { status: updated.status, revision: { increment: 1 }, payload: updated as unknown as Prisma.InputJsonValue },
      });
      if (saved.count !== 1) throw new CaseReviewRevisionConflictError(itemId);
      await prismaTouchReviewPlan(transaction, owner, plan, timestamp);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return (await this.getReviewPlan(owner, planId, actorId))!;
  }

  async approveReviewItems(owner: OwnerScope, planId: string, actorId: string, requested: Array<{ itemId: string; expectedRevision: number }>): Promise<CaseReviewPlanDetail> {
    await this.ready();
    if (new Set(requested.map(item => item.itemId)).size !== requested.length) throw new Error("Review items must be unique");
    await this.prisma.$transaction(async transaction => {
      const planRow = await transaction.qaseyCaseReviewPlanRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: planId } }, select: { payload: true, revision: true } });
      if (!planRow) throw new Error(`Case Review Plan ${planId} not found`);
      const plan = CaseReviewPlanSchema.parse({ ...(planRow.payload as object), revision: planRow.revision });
      assertReviewOwner(plan, actorId);
      await transaction.qaseyCaseProject.upsert({ where: { applicationId_tenantId_code: { ...owner, code: "QASEY" } }, create: { ...owner, code: "QASEY" }, update: {} });
      const projects = await transaction.$queryRaw<Array<{ nextCaseSequence: number }>>`
        SELECT next_case_sequence AS "nextCaseSequence" FROM qasey_case_projects
        WHERE application_id = ${owner.applicationId} AND tenant_id = ${owner.tenantId} AND code = 'QASEY' FOR UPDATE`;
      let nextSequence = projects[0]?.nextCaseSequence ?? 1;
      const timestamp = this.now().toISOString();
      for (const reference of requested) {
        const row = await transaction.qaseyCaseReviewItemRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: reference.itemId } }, select: { payload: true, revision: true } });
        if (!row) throw new Error(`Case review item ${reference.itemId} not found`);
        const item = CaseReviewItemSchema.parse({ ...(row.payload as object), revision: row.revision });
        if (item.planId !== planId) throw new Error(`Case review item ${item.id} does not belong to this plan`);
        if (item.revision !== reference.expectedRevision) throw new CaseReviewRevisionConflictError(item.id);
        if (item.status !== "pending") throw new Error(`Case review item ${item.id} is not pending`);
        const caseId = item.publishedCaseId ?? item.content.caseId ?? `QASEY-${nextSequence++}`;
        const existingRow = await transaction.qaseyCaseRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: caseId } }, select: { payload: true } });
        const existing = existingRow ? CaseHubCaseSchema.parse(existingRow.payload) : undefined;
        if (item.content.operation === "update" && !existing?.activeVersionId) throw new Error(`Case ${caseId} not found`);
        const previous = await transaction.qaseyCaseVersionRecord.findFirst({ where: { ...owner, caseId }, orderBy: { version: "desc" }, select: { version: true } });
        const versionNumber = (previous?.version ?? 0) + 1;
        const { operation: _operation, caseId: _requestedCaseId, ...business } = item.content;
        const content = { ...business, caseId, projectCode: "QASEY" as const, version: versionNumber, target: "web" as const };
        const version = CaseHubCaseVersionSchema.parse({
          ...owner, ...content, id: randomUUID(), evidenceRefs: plan.requirement.evidenceRefs,
          requirementSnapshotHash: plan.requirement.snapshotHash, contentHash: hashJson(content), status: "active",
          createdBy: actorId, createdAt: timestamp, automationStatus: item.publishedCaseVersionId ? "stale" : "none", systemTags: [],
        });
        await transaction.qaseyCaseVersionRecord.create({ data: {
          ...owner, id: version.id, caseId, changeSetId: null, version: version.version, status: version.status,
          payload: version as unknown as Prisma.InputJsonValue,
        } });
        const caseRecord = CaseHubCaseSchema.parse(existing ? {
          ...existing, activeVersionId: version.id, suitePath: version.suitePath, title: version.title, updatedAt: timestamp,
        } : {
          ...owner, id: caseId, projectCode: "QASEY", suitePath: version.suitePath, title: version.title,
          activeVersionId: version.id, proposedVersionIds: [], createdAt: timestamp, updatedAt: timestamp,
        });
        await transaction.qaseyCaseRecord.upsert({
          where: { applicationId_tenantId_id: { ...owner, id: caseId } },
          create: { ...owner, id: caseId, projectCode: "QASEY", suitePath: version.suitePath, title: version.title, activeVersionId: version.id, payload: caseRecord as unknown as Prisma.InputJsonValue },
          update: { suitePath: version.suitePath, title: version.title, activeVersionId: version.id, payload: caseRecord as unknown as Prisma.InputJsonValue },
        });
        const approved = CaseReviewItemSchema.parse({
          ...item, status: "approved", publishedCaseId: caseId, publishedCaseVersionId: version.id,
          approvedBy: actorId, approvedAt: timestamp, revision: item.revision + 1, updatedAt: timestamp,
        });
        const saved = await transaction.qaseyCaseReviewItemRecord.updateMany({
          where: { ...owner, id: item.id, planId, revision: item.revision },
          data: { status: approved.status, revision: { increment: 1 }, payload: approved as unknown as Prisma.InputJsonValue },
        });
        if (saved.count !== 1) throw new CaseReviewRevisionConflictError(item.id);
      }
      await transaction.qaseyCaseProject.update({ where: { applicationId_tenantId_code: { ...owner, code: "QASEY" } }, data: { nextCaseSequence: nextSequence } });
      await prismaTouchReviewPlan(transaction, owner, plan, timestamp);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return (await this.getReviewPlan(owner, planId, actorId))!;
  }

  async createChangeSet(owner: OwnerScope, command: CreateCaseHubChangeSetCommand): Promise<CaseHubChangeSet> {
    await this.ready();
    return this.prisma.$transaction(async transaction => {
      await transaction.qaseyCaseProject.upsert({
        where: { applicationId_tenantId_code: { ...owner, code: "QASEY" } },
        create: { ...owner, code: "QASEY" }, update: {},
      });
      const changeSetId = randomUUID();
      const versions: CaseHubCaseVersion[] = [];
      const project = await transaction.qaseyCaseProject.findUniqueOrThrow({
        where: { applicationId_tenantId_code: { ...owner, code: "QASEY" } },
        select: { nextCaseSequence: true },
      });
      const candidateStart = project.nextCaseSequence;
      let candidateSequence = candidateStart;
      for (const proposal of command.proposals) {
        let caseId = proposal.caseId;
        if (!caseId) {
          caseId = `QASEY-${candidateSequence++}`;
        }
        const previous = await transaction.qaseyCaseVersionRecord.findFirst({
          where: { ...owner, caseId }, orderBy: { version: "desc" }, select: { version: true },
        });
        if (proposal.operation === "update" && !previous) throw new Error(`Case ${caseId} not found`);
        const versionNumber = (previous?.version ?? 0) + 1;
        const { operation: _operation, ...caseContent } = proposal;
        const content = { ...caseContent, caseId, projectCode: "QASEY" as const, version: versionNumber, target: "web" as const };
        versions.push(CaseHubCaseVersionSchema.parse({
          ...owner, ...content, id: randomUUID(), requirementSnapshotHash: command.requirement.snapshotHash,
          contentHash: hashJson(content), status: "proposed", createdBy: command.createdBy,
          createdAt: this.now().toISOString(),
        }));
      }
      const timestamp = this.now().toISOString();
      const changeSet = CaseHubChangeSetSchema.parse({
        ...owner, id: changeSetId, projectCode: "QASEY", requirement: command.requirement,
        caseVersionIds: versions.map(version => version.id),
        ...(candidateSequence > candidateStart ? {
          candidateCaseSequenceRange: { start: candidateStart, end: candidateSequence - 1 },
        } : {}),
        caseIdsFinalized: candidateSequence === candidateStart,
        planHash: hashJson(versions.map(version => ({ caseId: version.caseId, contentHash: version.contentHash }))),
        status: "authoring", revision: 1, repository: command.repository,
        ...(command.baseSha ? { baseSha: command.baseSha } : {}),
        ...(command.environmentSourceSha ? { environmentSourceSha: command.environmentSourceSha } : {}),
        createdBy: command.createdBy, createdAt: timestamp, updatedAt: timestamp,
      });
      await transaction.qaseyCaseChangeSetRecord.create({ data: {
        ...owner, id: changeSet.id, status: changeSet.status, revision: 1,
        payload: changeSet as unknown as Prisma.InputJsonValue,
      } });
      for (const version of versions) {
        const existing = await transaction.qaseyCaseRecord.findUnique({
          where: { applicationId_tenantId_id: { ...owner, id: version.caseId } }, select: { payload: true },
        });
        const previousCase = existing ? CaseHubCaseSchema.parse(existing.payload) : undefined;
        const caseRecord = CaseHubCaseSchema.parse(previousCase ? {
          ...previousCase,
          ...(previousCase.activeVersionId ? {} : { title: version.title, suitePath: version.suitePath }),
          proposedVersionIds: [...previousCase.proposedVersionIds, version.id], updatedAt: timestamp,
        } : {
          ...owner, id: version.caseId, projectCode: "QASEY", suitePath: version.suitePath,
          title: version.title, proposedVersionIds: [version.id], createdAt: timestamp, updatedAt: timestamp,
        });
        await transaction.qaseyCaseRecord.upsert({
          where: { applicationId_tenantId_id: { ...owner, id: version.caseId } },
          create: { ...owner, id: version.caseId, projectCode: "QASEY", suitePath: version.suitePath, title: version.title, payload: caseRecord as unknown as Prisma.InputJsonValue },
          update: {
            ...(previousCase?.activeVersionId ? {} : { suitePath: version.suitePath, title: version.title }),
            payload: caseRecord as unknown as Prisma.InputJsonValue,
          },
        });
        await transaction.qaseyCaseVersionRecord.create({ data: {
          ...owner, id: version.id, caseId: version.caseId, changeSetId, version: version.version,
          status: version.status, payload: version as unknown as Prisma.InputJsonValue,
        } });
      }
      return changeSet;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async createAutomationChangeSet(owner: OwnerScope, command: CreateAutomationChangeSetCommand): Promise<CaseHubChangeSet> {
    await this.ready();
    const ids = [...new Set(command.caseVersionIds)];
    if (ids.length !== command.caseVersionIds.length) throw new Error("Case Version ids must be unique");
    return this.prisma.$transaction(async transaction => {
      const rows = await transaction.qaseyCaseVersionRecord.findMany({ where: { ...owner, id: { in: ids } }, select: { payload: true } });
      if (rows.length !== ids.length) throw new Error("One or more Case Versions do not exist");
      const versions = rows.map(row => CaseHubCaseVersionSchema.parse(row.payload));
      for (const version of versions) {
        const caseRow = await transaction.qaseyCaseRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: version.caseId } }, select: { activeVersionId: true, deletedAt: true } });
        if (caseRow?.deletedAt || version.status !== "active" || caseRow?.activeVersionId !== version.id) throw new Error(`Case Version ${version.id} is not the active approved version`);
      }
      const timestamp = this.now().toISOString();
      const changeSet = CaseHubChangeSetSchema.parse({
        ...owner, id: randomUUID(), projectCode: "QASEY", requirement: command.requirement,
        caseVersionIds: ids, caseIdsFinalized: true, planHash: hashJson(ids), status: "authoring", revision: 1,
        repository: command.repository, ...(command.baseSha ? { baseSha: command.baseSha } : {}),
        ...(command.environmentSourceSha ? { environmentSourceSha: command.environmentSourceSha } : {}),
        createdBy: command.createdBy, createdAt: timestamp, updatedAt: timestamp,
      });
      await transaction.qaseyCaseChangeSetRecord.create({ data: {
        ...owner, id: changeSet.id, status: changeSet.status, revision: changeSet.revision,
        payload: changeSet as unknown as Prisma.InputJsonValue,
      } });
      return changeSet;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async automationStatuses(owner: OwnerScope, caseVersionIds: string[]): Promise<Record<string, CaseAutomationStatus>> {
    await this.ready();
    const changeSets = await this.listChangeSets(owner, 500);
    const resultsByChangeSet = new Map<string, CaseHubResult[]>();
    const statuses: Record<string, CaseAutomationStatus> = {};
    for (const versionId of caseVersionIds) {
      let status: CaseAutomationStatus = "none";
      const related = changeSets.filter(changeSet => changeSet.caseVersionIds.includes(versionId)).sort(compareChangeSetRecency);
      for (const changeSet of related) {
        let results = resultsByChangeSet.get(changeSet.id);
        if (!results) { results = await this.listResults(owner, changeSet.id); resultsByChangeSet.set(changeSet.id, results); }
        status = automationStatusForChangeSet(changeSet, latestResultForVersion(results, versionId));
        if (status !== "none") break;
      }
      statuses[versionId] = status;
    }
    const requestedVersions = await this.prisma.qaseyCaseVersionRecord.findMany({ where: { ...owner, id: { in: caseVersionIds } }, select: { payload: true } });
    for (const row of requestedVersions) {
      const version = CaseHubCaseVersionSchema.parse(row.payload);
      if (statuses[version.id] !== "none") continue;
      const caseRow = await this.prisma.qaseyCaseRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: version.caseId } }, select: { activeVersionId: true } });
      if (caseRow?.activeVersionId !== version.id) continue;
      const older = await this.prisma.qaseyCaseVersionRecord.findMany({ where: { ...owner, caseId: version.caseId, id: { not: version.id } }, select: { id: true } });
      if (!older.length) continue;
      const olderStatuses = await this.automationStatuses(owner, older.map(item => item.id));
      if (Object.values(olderStatuses).includes("verified")) statuses[version.id] = "stale";
    }
    return statuses;
  }

  async getChangeSet(owner: OwnerScope, id: string): Promise<CaseHubChangeSet | undefined> {
    await this.ready();
    const row = await this.prisma.qaseyCaseChangeSetRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id } }, select: { payload: true, revision: true } });
    return row ? CaseHubChangeSetSchema.parse({ ...(row.payload as object), revision: row.revision }) : undefined;
  }
  async listChangeSets(owner: OwnerScope, limit = 100): Promise<CaseHubChangeSet[]> {
    await this.ready();
    const rows = await this.prisma.qaseyCaseChangeSetRecord.findMany({ where: owner, orderBy: { updatedAt: "desc" }, take: boundedLimit(limit), select: { payload: true, revision: true } });
    return rows.map(row => CaseHubChangeSetSchema.parse({ ...(row.payload as object), revision: row.revision }));
  }
  async updateChangeSet(owner: OwnerScope, id: string, expectedRevision: number, patch: CaseHubChangeSetPatch): Promise<CaseHubChangeSet> {
    await this.ready();
    return this.prisma.$transaction(async transaction => {
      const row = await transaction.qaseyCaseChangeSetRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id } }, select: { payload: true, revision: true } });
      if (!row) throw new Error(`Case Hub change set ${id} not found`);
      if (row.revision !== expectedRevision) throw new CaseHubRevisionConflictError(id);
      const current = CaseHubChangeSetSchema.parse({ ...(row.payload as object), revision: row.revision });
      assertChangeSetTransition(current.status, patch.status);
      const updated = CaseHubChangeSetSchema.parse({ ...current, ...patch, revision: current.revision + 1, updatedAt: this.now().toISOString() });
      const result = await transaction.qaseyCaseChangeSetRecord.updateMany({ where: { ...owner, id, revision: expectedRevision }, data: { status: updated.status, revision: { increment: 1 }, payload: updated as unknown as Prisma.InputJsonValue } });
      if (result.count !== 1) throw new CaseHubRevisionConflictError(id);
      return updated;
    });
  }
  async listCases(owner: OwnerScope, query = ""): Promise<CaseHubCase[]> {
    await this.ready();
    const normalized = query.trim();
    const rows = await this.prisma.qaseyCaseRecord.findMany({
      where: { ...owner, deletedAt: null, activeVersionId: { not: null }, ...(normalized ? { OR: [{ id: { contains: normalized, mode: "insensitive" } }, { title: { contains: normalized, mode: "insensitive" } }, { suitePath: { contains: normalized, mode: "insensitive" } }] } : {}) },
      orderBy: { createdAt: "asc" }, select: { payload: true },
    });
    const cases = rows.map(row => CaseHubCaseSchema.parse(row.payload));
    const statuses = await this.automationStatuses(owner, cases.flatMap(item => item.activeVersionId ? [item.activeVersionId] : []));
    return cases.map(item => CaseHubCaseSchema.parse({
      ...item, automationStatus: item.activeVersionId ? statuses[item.activeVersionId] ?? "none" : "none",
      systemTags: item.activeVersionId && statuses[item.activeVersionId] === "verified" ? ["e2e"] : [],
    }));
  }
  async getCase(owner: OwnerScope, id: string): Promise<CaseHubCase | undefined> {
    await this.ready();
    const row = await this.prisma.qaseyCaseRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id }, deletedAt: null }, select: { payload: true } });
    return row ? CaseHubCaseSchema.parse(row.payload) : undefined;
  }
  async deleteCase(owner: OwnerScope, id: string): Promise<boolean> {
    await this.ready();
    const result = await this.prisma.qaseyCaseRecord.updateMany({
      where: { ...owner, id, activeVersionId: { not: null }, deletedAt: null },
      data: { deletedAt: this.now() },
    });
    if (result.count > 0) return true;
    return Boolean(await this.prisma.qaseyCaseRecord.findFirst({
      where: { ...owner, id, deletedAt: { not: null } }, select: { id: true },
    }));
  }
  async versionsForCase(owner: OwnerScope, caseId: string): Promise<CaseHubCaseVersion[]> {
    await this.ready();
    const rows = await this.prisma.qaseyCaseVersionRecord.findMany({ where: { ...owner, caseId }, orderBy: { version: "asc" }, select: { payload: true } });
    return rows.map(row => CaseHubCaseVersionSchema.parse(row.payload));
  }
  async versionsForChangeSet(owner: OwnerScope, changeSetId: string): Promise<CaseHubCaseVersion[]> {
    await this.ready();
    const changeSet = await this.getChangeSet(owner, changeSetId);
    if (!changeSet) return [];
    const rows = await this.prisma.qaseyCaseVersionRecord.findMany({ where: { ...owner, id: { in: changeSet.caseVersionIds } }, orderBy: [{ caseId: "asc" }, { version: "asc" }], select: { payload: true } });
    return rows.map(row => CaseHubCaseVersionSchema.parse(row.payload));
  }
  async createPendingResults(owner: OwnerScope, changeSetId: string, runId: string, artifacts: ArtifactRef[] = [], caseVersionIds?: string[], observations: CaseExecutionObservation[] = []): Promise<CaseHubResult[]> {
    await this.ready();
    const selected = caseVersionIds ? new Set(caseVersionIds) : undefined;
    const versions = (await this.versionsForChangeSet(owner, changeSetId)).filter(version => !selected || selected.has(version.id));
    return this.prisma.$transaction(async transaction => {
      const created: CaseHubResult[] = [];
      for (const version of versions) {
        if (version.status !== "active") {
          const proposed = CaseHubCaseVersionSchema.parse({ ...version, status: "proposed" });
          await transaction.qaseyCaseVersionRecord.update({ where: { applicationId_tenantId_id: { ...owner, id: version.id } }, data: { status: "proposed", payload: proposed as unknown as Prisma.InputJsonValue } });
        }
        const previous = await transaction.qaseyCaseResultRecord.findFirst({ where: { ...owner, changeSetId, caseVersionId: version.id }, orderBy: { attempt: "desc" }, select: { attempt: true } });
        const observation = observations.find(item => item.caseId === version.caseId);
        const result = CaseHubResultSchema.parse({
          ...owner, id: randomUUID(), changeSetId, runId, caseVersionId: version.id, caseId: version.caseId,
          attempt: (previous?.attempt ?? 0) + 1, executionStatus: observation?.executionStatus ?? "passed", reviewStatus: "pending", artifacts: artifactsForCase(artifacts, version.caseId, observation?.artifactNames),
          ...(observation?.durationMs !== undefined ? { durationMs: observation.durationMs } : {}),
          ...(artifacts.find(artifact => artifact.kind === "patch")?.sha256 ? { testCodeHash: artifacts.find(artifact => artifact.kind === "patch")!.sha256 } : {}),
          createdAt: this.now().toISOString(),
        });
        await transaction.qaseyCaseResultRecord.create({ data: {
          ...owner, id: result.id, changeSetId, runId, caseVersionId: version.id, caseId: version.caseId,
          attempt: result.attempt, executionStatus: result.executionStatus, reviewStatus: result.reviewStatus,
          payload: result as unknown as Prisma.InputJsonValue,
        } });
        created.push(result);
      }
      return created;
    });
  }
  async listResults(owner: OwnerScope, changeSetId: string): Promise<CaseHubResult[]> {
    await this.ready();
    const rows = await this.prisma.qaseyCaseResultRecord.findMany({ where: { ...owner, changeSetId }, orderBy: [{ caseId: "asc" }, { attempt: "asc" }], select: { payload: true } });
    return rows.map(row => CaseHubResultSchema.parse(row.payload));
  }
  async getResult(owner: OwnerScope, resultId: string): Promise<CaseHubResult | undefined> {
    await this.ready();
    const row = await this.prisma.qaseyCaseResultRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: resultId } }, select: { payload: true } });
    return row ? CaseHubResultSchema.parse(row.payload) : undefined;
  }
  async reviewResult(owner: OwnerScope, resultId: string, reviewerId: string, input: unknown): Promise<CaseHubResult> {
    await this.ready();
    const review = CaseHubResultReviewInputSchema.parse(input);
    const current = await this.getResult(owner, resultId);
    if (!current) throw new Error(`Case Hub result ${resultId} not found`);
    const requestedStatus = reviewStatusForVerdict(review.verdict);
    if (current.reviewStatus !== "pending") {
      if (isSameReview(current, reviewerId, requestedStatus, review.feedback)) return current;
      throw new Error("Only pending results can be reviewed");
    }
    if (review.verdict === "approve" && current.executionStatus !== "passed") throw new Error("Only passed results can be approved");
    if (review.verdict === "approve" && !current.artifacts.some(isQaReviewArtifact)) throw new Error("A video or Playwright trace is required before approval");
    const updated = CaseHubResultSchema.parse({
      ...current,
      reviewStatus: requestedStatus,
      reviewerId, ...(review.feedback ? { feedback: review.feedback } : {}), reviewedAt: this.now().toISOString(),
    });
    await this.prisma.$transaction(async transaction => {
      await transaction.qaseyCaseResultRecord.update({ where: { applicationId_tenantId_id: { ...owner, id: resultId } }, data: { reviewStatus: updated.reviewStatus, payload: updated as unknown as Prisma.InputJsonValue } });
      if (updated.reviewStatus === "approved") {
        const row = await transaction.qaseyCaseVersionRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: updated.caseVersionId } }, select: { payload: true } });
        if (row) {
          const version = CaseHubCaseVersionSchema.parse(row.payload);
          if (version.status === "proposed") {
            const approved = CaseHubCaseVersionSchema.parse({ ...version, status: "approved" });
            await transaction.qaseyCaseVersionRecord.update({ where: { applicationId_tenantId_id: { ...owner, id: version.id } }, data: { status: "approved", payload: approved as unknown as Prisma.InputJsonValue } });
          }
        }
      }
    });
    return updated;
  }
  async finalizeApprovedCaseIds(owner: OwnerScope, changeSetId: string): Promise<CaseHubChangeSet> {
    await this.ready();
    return this.prisma.$transaction(async transaction => {
      const row = await transaction.qaseyCaseChangeSetRecord.findUnique({
        where: { applicationId_tenantId_id: { ...owner, id: changeSetId } },
        select: { payload: true, revision: true },
      });
      if (!row) throw new Error(`Case Hub change set ${changeSetId} not found`);
      const changeSet = CaseHubChangeSetSchema.parse({ ...(row.payload as object), revision: row.revision });
      if (changeSet.caseIdsFinalized) return changeSet;
      const results = await transaction.qaseyCaseResultRecord.findMany({
        where: { ...owner, changeSetId },
        orderBy: [{ caseVersionId: "asc" }, { attempt: "asc" }],
        select: { payload: true },
      });
      const parsedResults = results.map(result => CaseHubResultSchema.parse(result.payload));
      for (const versionId of changeSet.caseVersionIds) {
        const latest = parsedResults.filter(result => result.caseVersionId === versionId).at(-1);
        if (latest?.reviewStatus !== "approved") throw new Error(`Case Version ${versionId} is not approved`);
      }
      const range = changeSet.candidateCaseSequenceRange;
      if (!range) throw new Error(`Case Hub change set ${changeSetId} has no candidate Case sequence range`);
      const projects = await transaction.$queryRaw<Array<{ nextCaseSequence: number }>>`
        SELECT next_case_sequence AS "nextCaseSequence"
        FROM qasey_case_projects
        WHERE application_id = ${owner.applicationId} AND tenant_id = ${owner.tenantId} AND code = 'QASEY'
        FOR UPDATE`;
      const next = projects[0]?.nextCaseSequence;
      if (!next) throw new Error("Case Hub project sequence is unavailable");
      if (next !== range.start) throw new CaseHubCaseSequenceConflictError(changeSetId, range.start, next);
      await transaction.qaseyCaseProject.update({
        where: { applicationId_tenantId_code: { ...owner, code: "QASEY" } },
        data: { nextCaseSequence: range.end + 1 },
      });
      const updated = CaseHubChangeSetSchema.parse({
        ...changeSet,
        caseIdsFinalized: true,
        revision: changeSet.revision + 1,
        updatedAt: this.now().toISOString(),
      });
      const saved = await transaction.qaseyCaseChangeSetRecord.updateMany({
        where: { ...owner, id: changeSetId, revision: changeSet.revision },
        data: { revision: { increment: 1 }, payload: updated as unknown as Prisma.InputJsonValue },
      });
      if (saved.count !== 1) throw new CaseHubRevisionConflictError(changeSetId);
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  async activateApprovedVersions(owner: OwnerScope, changeSetId: string): Promise<void> {
    await this.ready();
    const [versions, results] = await Promise.all([this.versionsForChangeSet(owner, changeSetId), this.listResults(owner, changeSetId)]);
    await this.prisma.$transaction(async transaction => {
      for (const version of versions) {
        const latest = results.filter(result => result.caseVersionId === version.id).at(-1);
        if (latest?.reviewStatus !== "approved") throw new Error(`Case ${version.caseId} is not approved`);
        const row = await transaction.qaseyCaseRecord.findUniqueOrThrow({ where: { applicationId_tenantId_id: { ...owner, id: version.caseId } }, select: { payload: true } });
        const current = CaseHubCaseSchema.parse(row.payload);
        if (version.status === "active" && current.activeVersionId === version.id) continue;
        const active = CaseHubCaseVersionSchema.parse({ ...version, status: "active" });
        await transaction.qaseyCaseVersionRecord.update({ where: { applicationId_tenantId_id: { ...owner, id: version.id } }, data: { status: "active", payload: active as unknown as Prisma.InputJsonValue } });
        const updated = CaseHubCaseSchema.parse({ ...current, activeVersionId: version.id, proposedVersionIds: current.proposedVersionIds.filter(id => id !== version.id), title: version.title, suitePath: version.suitePath, updatedAt: this.now().toISOString() });
        await transaction.qaseyCaseRecord.update({ where: { applicationId_tenantId_id: { ...owner, id: version.caseId } }, data: { activeVersionId: version.id, title: version.title, suitePath: version.suitePath, payload: updated as unknown as Prisma.InputJsonValue } });
      }
    });
  }
  async close(): Promise<void> {}
}

async function prismaMutableReviewItem(
  transaction: Prisma.TransactionClient,
  owner: OwnerScope,
  planId: string,
  itemId: string,
  actorId: string,
  expectedRevision: number,
): Promise<{ plan: CaseReviewPlan; item: CaseReviewItem }> {
  const [planRow, itemRow] = await Promise.all([
    transaction.qaseyCaseReviewPlanRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: planId } }, select: { payload: true, revision: true } }),
    transaction.qaseyCaseReviewItemRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: itemId } }, select: { payload: true, revision: true } }),
  ]);
  if (!planRow) throw new Error(`Case Review Plan ${planId} not found`);
  const plan = CaseReviewPlanSchema.parse({ ...(planRow.payload as object), revision: planRow.revision });
  assertReviewOwner(plan, actorId);
  if (!itemRow) throw new Error(`Case review item ${itemId} not found`);
  const item = CaseReviewItemSchema.parse({ ...(itemRow.payload as object), revision: itemRow.revision });
  if (item.planId !== planId) throw new Error(`Case review item ${itemId} does not belong to this plan`);
  if (item.revision !== expectedRevision) throw new CaseReviewRevisionConflictError(itemId);
  return { plan, item };
}

async function prismaTouchReviewPlan(
  transaction: Prisma.TransactionClient,
  owner: OwnerScope,
  plan: CaseReviewPlan,
  timestamp: string,
): Promise<void> {
  const pending = await transaction.qaseyCaseReviewItemRecord.count({ where: { ...owner, planId: plan.id, status: "pending" } });
  const updated = CaseReviewPlanSchema.parse({
    ...plan, status: pending === 0 ? "ready" : "reviewing", revision: plan.revision + 1, updatedAt: timestamp,
  });
  const saved = await transaction.qaseyCaseReviewPlanRecord.updateMany({
    where: { ...owner, id: plan.id, revision: plan.revision },
    data: { status: updated.status, revision: { increment: 1 }, payload: updated as unknown as Prisma.InputJsonValue },
  });
  if (saved.count !== 1) throw new CaseReviewRevisionConflictError(plan.id);
}

function assertReviewOwner(plan: CaseReviewPlan, actorId: string): void {
  if (plan.subjectId !== actorId || plan.createdBy !== actorId) throw new CaseReviewForbiddenError();
  if (plan.status === "cancelled") throw new Error("Cancelled Case Review Plans cannot be changed");
}

/**
 * Build the Case Hub read model without changing immutable Case Versions,
 * Change Sets, or results. `current` is the canonical Case pointer; `history`
 * keeps the evidence for every previous version intact.
 */
export function projectCaseHubDetail(
  caseRecord: CaseHubCase,
  versions: CaseHubCaseVersion[],
  changeSets: CaseHubChangeSet[],
  results: CaseHubResult[],
): CaseHubCaseDetail {
  const orderedVersions = [...versions].sort((left, right) => left.version - right.version || left.id.localeCompare(right.id));
  const projections = new Map<string, CaseAutomationProjection>();
  for (const version of orderedVersions) projections.set(version.id, automationProjectionForVersion(version.id, changeSets, results));

  const currentVersionId = caseRecord.activeVersionId;
  const currentVersion = currentVersionId ? orderedVersions.find(version => version.id === currentVersionId) : undefined;
  if (!currentVersion) throw new Error(`Case ${caseRecord.id} has no current Case Version`);

  // An unchanged current version without its own E2E result is explicitly
  // marked stale only when an older version has verified evidence.
  const currentProjection = projections.get(currentVersion.id)!;
  if (currentProjection.status === "none" && [...projections.entries()].some(([id, projection]) => id !== currentVersion.id && projection.status === "verified")) {
    projections.set(currentVersion.id, { status: "stale" });
  }

  const present = (version: CaseHubCaseVersion): CaseHubCaseVersionPresentation => {
    const automation = projections.get(version.id)!;
    return {
      ...version,
      isCurrent: version.id === currentVersion.id,
      automationStatus: automation.status,
      systemTags: automation.status === "verified" ? ["e2e"] : [],
      automation,
    };
  };
  const presentedVersions = orderedVersions.map(present);
  const presentedCurrent = presentedVersions.find(version => version.isCurrent)!;
  const currentAutomation = projections.get(currentVersion.id)!;
  const history = presentedVersions.map(version => ({
    version,
    changeSets: changeSets.filter(changeSet => changeSet.caseVersionIds.includes(version.id)).sort(compareChangeSetRecency),
    results: results.filter(result => result.caseVersionId === version.id).sort(compareResultRecency),
  }));

  return CaseHubCaseDetailSchema.parse({
    case: {
      ...caseRecord,
      automationStatus: currentAutomation.status,
      systemTags: currentAutomation.status === "verified" ? ["e2e"] : [],
    },
    current: { version: presentedCurrent, automation: currentAutomation },
    history,
    versions: presentedVersions,
    changeSets: [...changeSets].sort(compareChangeSetRecency),
    results: [...results].sort(compareResultRecency),
  });
}

export function caseHubVersionToTestCase(version: CaseHubCaseVersion): TestCaseSpec {
  return {
    id: version.caseId,
    versionHash: version.contentHash,
    ...(version.automationPath ? { automationPath: version.automationPath } : {}),
    title: version.title,
    target: "web",
    priority: version.priority,
    evidenceRefs: version.evidenceRefs.map(reference => ({ source: reference.kind, ref: reference.ref })),
    preconditions: version.preconditions,
    steps: version.steps,
    testData: version.testData,
    tags: version.tags,
    unresolvedQuestions: [],
  };
}

function automationProjectionForVersion(versionId: string, changeSets: CaseHubChangeSet[], results: CaseHubResult[]): CaseAutomationProjection {
  for (const changeSet of changeSets.filter(item => item.caseVersionIds.includes(versionId)).sort(compareChangeSetRecency)) {
    const result = latestResultForVersion(results.filter(item => item.changeSetId === changeSet.id), versionId);
    const status = automationStatusForChangeSet(changeSet, result);
    if (status === "none") continue;
    return {
      status,
      changeSetId: changeSet.id,
      changeSetStatus: changeSet.status,
      ...(result ? {
        resultId: result.id,
        resultAttempt: result.attempt,
        observedAt: result.reviewedAt ?? result.createdAt,
      } : {}),
    };
  }
  return { status: "none" };
}

function automationStatusForChangeSet(changeSet: CaseHubChangeSet, latest: CaseHubResult | undefined): CaseAutomationStatus {
  // These phases mean a new attempt is in flight. Any stored result belongs
  // to an earlier attempt and must not reopen E2E generation yet.
  if (["authoring", "verifying", "revising", "final_verifying"].includes(changeSet.status)) return "generating";
  // Once a Change Set is awaiting review, its latest result is authoritative
  // even if the workflow has not yet copied a terminal phase to the Change Set.
  if (latest?.reviewStatus === "approved" && !["abandoned", "cancelled"].includes(changeSet.status)) return "verified";
  if (latest?.executionStatus === "failed"
    || ["changes_requested", "product_bug", "environment_issue"].includes(latest?.reviewStatus ?? "")) return "failed";
  if (latest?.reviewStatus === "pending") return "awaiting_review";
  if (changeSet.status === "awaiting_review") return "awaiting_review";
  if (["failed", "blocked_product", "blocked_environment"].includes(changeSet.status)) return "failed";
  return "none";
}

function latestResultForVersion(results: CaseHubResult[], versionId: string): CaseHubResult | undefined {
  return results.filter(result => result.caseVersionId === versionId).sort(compareResultRecency)[0];
}

function compareChangeSetRecency(left: CaseHubChangeSet, right: CaseHubChangeSet): number {
  // `updatedAt` changes when an older run finishes. Current automation means
  // the newest attempted Change Set, so creation time is the ordering key.
  return right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id);
}

function compareResultRecency(left: CaseHubResult, right: CaseHubResult): number {
  return right.createdAt.localeCompare(left.createdAt)
    || right.attempt - left.attempt
    || right.id.localeCompare(left.id);
}

const CHANGE_SET_TRANSITIONS: Record<CaseHubChangeSetStatus, readonly CaseHubChangeSetStatus[]> = {
  authoring: ["verifying", "blocked_product", "blocked_environment", "failed", "cancelled", "abandoned"],
  verifying: ["awaiting_review", "failed", "cancelled", "blocked_environment", "abandoned"],
  awaiting_review: ["revising", "blocked_product", "blocked_environment", "final_verifying", "cancelled", "abandoned"],
  revising: ["verifying", "failed", "cancelled", "abandoned"],
  blocked_product: ["verifying", "cancelled", "abandoned"],
  blocked_environment: ["verifying", "cancelled", "abandoned"],
  final_verifying: ["ready_to_merge", "awaiting_review", "failed", "cancelled", "abandoned"],
  ready_to_merge: ["merged", "abandoned"],
  merged: [], failed: ["verifying"], cancelled: [], abandoned: [],
};

export function assertChangeSetTransition(from: CaseHubChangeSetStatus, to?: CaseHubChangeSetStatus): void {
  if (to && to !== from && !CHANGE_SET_TRANSITIONS[from].includes(to)) throw new Error(`Invalid Case Hub change set transition: ${from} -> ${to}`);
}

function boundedLimit(limit: number): number { return Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 100, 1), 500); }
function artifactsForCase(artifacts: ArtifactRef[], caseId: string, observedArtifactNames: string[] = []): ArtifactRef[] {
  const normalizedCaseId = caseId.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const observed = observedArtifactNames.map(name => name.replaceAll("\\", "/"));
  return artifacts.filter(artifact => {
    if (!isQaReviewArtifact(artifact)) return false;
    const artifactName = artifact.name.replaceAll("\\", "/");
    if (observed.some(name => artifactName.endsWith(name))) return true;
    return artifact.name.toLowerCase().replace(/[^a-z0-9]/gu, "").includes(normalizedCaseId);
  });
}
function isQaReviewArtifact(artifact: ArtifactRef): boolean {
  return artifact.kind === "video"
    || artifact.kind === "trace" && /(?:^|\/)trace\.zip$/iu.test(artifact.name.replaceAll("\\", "/"));
}
function reviewStatusForVerdict(verdict: "approve" | "request_changes" | "product_bug" | "environment_issue"): CaseHubResult["reviewStatus"] {
  return verdict === "approve" ? "approved" : verdict === "request_changes" ? "changes_requested" : verdict;
}
function isSameReview(current: CaseHubResult, reviewerId: string, requestedStatus: CaseHubResult["reviewStatus"], feedback?: string): boolean {
  return current.reviewStatus === requestedStatus
    && current.reviewerId === reviewerId
    && (current.feedback ?? undefined) === (feedback ?? undefined);
}
function caseSequence(id: string): number { return Number(id.slice("QASEY-".length)); }
function ownerPrefix(owner: OwnerScope): string { return `${owner.applicationId}\u0000${owner.tenantId}\u0000`; }
function ownerKey(owner: OwnerScope, id: string): string { return `${ownerPrefix(owner)}${id}`; }
function clone<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : structuredClone(value); }
