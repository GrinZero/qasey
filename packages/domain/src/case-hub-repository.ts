import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  CaseHubCaseSchema,
  CaseHubCaseVersionSchema,
  CaseHubChangeSetSchema,
  CaseHubResultReviewInputSchema,
  CaseHubResultSchema,
  type ArtifactRef,
  type CaseHubCase,
  type CaseHubCaseProposal,
  type CaseHubCaseVersion,
  type CaseHubChangeSet,
  type CaseHubChangeSetStatus,
  type CaseHubResult,
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

export interface CaseExecutionObservation {
  caseId: string;
  executionStatus: CaseHubResult["executionStatus"];
  durationMs?: number;
  artifactNames?: string[];
}

export type CaseHubChangeSetPatch = Partial<Pick<CaseHubChangeSet,
  "status" | "runId" | "branch" | "pullRequestUrl" | "baseSha" | "environmentSourceSha" | "error"
>>;

export interface CaseHubRepository {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  createChangeSet(owner: OwnerScope, command: CreateCaseHubChangeSetCommand): Promise<CaseHubChangeSet>;
  getChangeSet(owner: OwnerScope, id: string): Promise<CaseHubChangeSet | undefined>;
  listChangeSets(owner: OwnerScope, limit?: number): Promise<CaseHubChangeSet[]>;
  updateChangeSet(owner: OwnerScope, id: string, expectedRevision: number, patch: CaseHubChangeSetPatch): Promise<CaseHubChangeSet>;
  listCases(owner: OwnerScope, query?: string): Promise<CaseHubCase[]>;
  getCase(owner: OwnerScope, id: string): Promise<CaseHubCase | undefined>;
  versionsForCase(owner: OwnerScope, caseId: string): Promise<CaseHubCaseVersion[]>;
  versionsForChangeSet(owner: OwnerScope, changeSetId: string): Promise<CaseHubCaseVersion[]>;
  createPendingResults(owner: OwnerScope, changeSetId: string, runId: string, artifacts?: ArtifactRef[], caseVersionIds?: string[], observations?: CaseExecutionObservation[]): Promise<CaseHubResult[]>;
  listResults(owner: OwnerScope, changeSetId: string): Promise<CaseHubResult[]>;
  getResult(owner: OwnerScope, resultId: string): Promise<CaseHubResult | undefined>;
  reviewResult(owner: OwnerScope, resultId: string, reviewerId: string, input: unknown): Promise<CaseHubResult>;
  activateApprovedVersions(owner: OwnerScope, changeSetId: string): Promise<void>;
  close?(): Promise<void>;
}

export class CaseHubRevisionConflictError extends Error {
  readonly code = "case_hub_revision_conflict";
  constructor(readonly changeSetId: string) {
    super(`Case Hub change set ${changeSetId} revision conflict`);
  }
}

export class InMemoryCaseHubRepository implements CaseHubRepository {
  private readonly cases = new Map<string, CaseHubCase>();
  private readonly versions = new Map<string, CaseHubCaseVersion>();
  private readonly changeSets = new Map<string, CaseHubChangeSet>();
  private readonly results = new Map<string, CaseHubResult>();
  private readonly sequences = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}
  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async createChangeSet(owner: OwnerScope, command: CreateCaseHubChangeSetCommand): Promise<CaseHubChangeSet> {
    const changeSetId = randomUUID();
    const versions = command.proposals.map(proposal => this.buildVersion(owner, changeSetId, command, proposal));
    const now = this.now().toISOString();
    const changeSet = CaseHubChangeSetSchema.parse({
      ...owner,
      id: changeSetId,
      projectCode: "QASEY",
      requirement: command.requirement,
      caseVersionIds: versions.map(version => version.id),
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
    return [...this.cases.entries()]
      .filter(([key]) => key.startsWith(ownerPrefix(owner)))
      .map(([, value]) => structuredClone(value))
      .filter(value => !normalized || `${value.id} ${value.title} ${value.suitePath}`.toLowerCase().includes(normalized))
      .sort((left, right) => caseSequence(left.id) - caseSequence(right.id));
  }

  async getCase(owner: OwnerScope, id: string): Promise<CaseHubCase | undefined> {
    return clone(this.cases.get(ownerKey(owner, id)));
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
      this.versions.set(ownerKey(owner, version.id), CaseHubCaseVersionSchema.parse({ ...version, status: "proposed" }));
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
    if (current.reviewStatus !== "pending") throw new Error("Only pending results can be reviewed");
    if (review.verdict === "approve" && current.executionStatus !== "passed") {
      throw new Error("Only passed results can be approved");
    }
    const reviewStatus = review.verdict === "approve" ? "approved" : review.verdict;
    const updated = CaseHubResultSchema.parse({
      ...current, reviewStatus, reviewerId, ...(review.feedback ? { feedback: review.feedback } : {}), reviewedAt: this.now().toISOString(),
    });
    this.results.set(key, updated);
    if (updated.reviewStatus === "approved") {
      const versionKey = ownerKey(owner, updated.caseVersionId);
      const version = this.versions.get(versionKey);
      if (version) this.versions.set(versionKey, CaseHubCaseVersionSchema.parse({ ...version, status: "approved" }));
    }
    return structuredClone(updated);
  }

  async activateApprovedVersions(owner: OwnerScope, changeSetId: string): Promise<void> {
    const [versions, results] = await Promise.all([
      this.versionsForChangeSet(owner, changeSetId), this.listResults(owner, changeSetId),
    ]);
    for (const version of versions) {
      const latest = results.filter(result => result.caseVersionId === version.id).at(-1);
      if (latest?.reviewStatus !== "approved") throw new Error(`Case ${version.caseId} is not approved`);
      const active = CaseHubCaseVersionSchema.parse({ ...version, status: "active" });
      this.versions.set(ownerKey(owner, version.id), active);
      const caseRecord = this.cases.get(ownerKey(owner, version.caseId));
      if (!caseRecord) throw new Error(`Case ${version.caseId} not found`);
      this.cases.set(ownerKey(owner, version.caseId), CaseHubCaseSchema.parse({
        ...caseRecord, activeVersionId: version.id,
        proposedVersionIds: caseRecord.proposedVersionIds.filter(id => id !== version.id),
        title: version.title, suitePath: version.suitePath, updatedAt: this.now().toISOString(),
      }));
    }
  }

  async close(): Promise<void> {}

  private buildVersion(owner: OwnerScope, changeSetId: string, command: CreateCaseHubChangeSetCommand, proposal: CaseHubCaseProposal): CaseHubCaseVersion {
    const caseId = proposal.caseId ?? this.nextCaseId(owner);
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
      ...existing, title: version.title, suitePath: version.suitePath,
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

  private nextCaseId(owner: OwnerScope): string {
    const key = `${ownerPrefix(owner)}QASEY`;
    const sequence = this.sequences.get(key) ?? 1;
    this.sequences.set(key, sequence + 1);
    return `QASEY-${sequence}`;
  }
}

export class PrismaCaseHubRepository implements CaseHubRepository {
  private initialized?: Promise<void>;
  constructor(private readonly prisma: PrismaClient, private readonly now: () => Date = () => new Date()) {}
  init(): Promise<void> { this.initialized ??= this.prisma.$connect(); return this.initialized; }
  private ready(): Promise<void> { return this.initialized ?? Promise.reject(new Error("PrismaCaseHubRepository has not been initialized")); }
  async healthCheck(): Promise<void> { await this.ready(); await this.prisma.$queryRaw`SELECT 1`; }

  async createChangeSet(owner: OwnerScope, command: CreateCaseHubChangeSetCommand): Promise<CaseHubChangeSet> {
    await this.ready();
    return this.prisma.$transaction(async transaction => {
      await transaction.qaseyCaseProject.upsert({
        where: { applicationId_tenantId_code: { ...owner, code: "QASEY" } },
        create: { ...owner, code: "QASEY" }, update: {},
      });
      const changeSetId = randomUUID();
      const versions: CaseHubCaseVersion[] = [];
      for (const proposal of command.proposals) {
        let caseId = proposal.caseId;
        if (!caseId) {
          const rows = await transaction.$queryRaw<Array<{ sequence: number }>>`
            UPDATE qasey_case_projects
            SET next_case_sequence = next_case_sequence + 1, updated_at = now()
            WHERE application_id = ${owner.applicationId} AND tenant_id = ${owner.tenantId} AND code = 'QASEY'
            RETURNING next_case_sequence - 1 AS sequence`;
          const sequence = rows[0]?.sequence;
          if (!sequence) throw new Error("Failed to allocate a Case Hub case id");
          caseId = `QASEY-${sequence}`;
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
          ...previousCase, title: version.title, suitePath: version.suitePath,
          proposedVersionIds: [...previousCase.proposedVersionIds, version.id], updatedAt: timestamp,
        } : {
          ...owner, id: version.caseId, projectCode: "QASEY", suitePath: version.suitePath,
          title: version.title, proposedVersionIds: [version.id], createdAt: timestamp, updatedAt: timestamp,
        });
        await transaction.qaseyCaseRecord.upsert({
          where: { applicationId_tenantId_id: { ...owner, id: version.caseId } },
          create: { ...owner, id: version.caseId, projectCode: "QASEY", suitePath: version.suitePath, title: version.title, payload: caseRecord as unknown as Prisma.InputJsonValue },
          update: { suitePath: version.suitePath, title: version.title, payload: caseRecord as unknown as Prisma.InputJsonValue },
        });
        await transaction.qaseyCaseVersionRecord.create({ data: {
          ...owner, id: version.id, caseId: version.caseId, changeSetId, version: version.version,
          status: version.status, payload: version as unknown as Prisma.InputJsonValue,
        } });
      }
      return changeSet;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
      where: { ...owner, ...(normalized ? { OR: [{ id: { contains: normalized, mode: "insensitive" } }, { title: { contains: normalized, mode: "insensitive" } }, { suitePath: { contains: normalized, mode: "insensitive" } }] } : {}) },
      orderBy: { createdAt: "asc" }, select: { payload: true },
    });
    return rows.map(row => CaseHubCaseSchema.parse(row.payload));
  }
  async getCase(owner: OwnerScope, id: string): Promise<CaseHubCase | undefined> {
    await this.ready();
    const row = await this.prisma.qaseyCaseRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id } }, select: { payload: true } });
    return row ? CaseHubCaseSchema.parse(row.payload) : undefined;
  }
  async versionsForCase(owner: OwnerScope, caseId: string): Promise<CaseHubCaseVersion[]> {
    await this.ready();
    const rows = await this.prisma.qaseyCaseVersionRecord.findMany({ where: { ...owner, caseId }, orderBy: { version: "asc" }, select: { payload: true } });
    return rows.map(row => CaseHubCaseVersionSchema.parse(row.payload));
  }
  async versionsForChangeSet(owner: OwnerScope, changeSetId: string): Promise<CaseHubCaseVersion[]> {
    await this.ready();
    const rows = await this.prisma.qaseyCaseVersionRecord.findMany({ where: { ...owner, changeSetId }, orderBy: [{ caseId: "asc" }, { version: "asc" }], select: { payload: true } });
    return rows.map(row => CaseHubCaseVersionSchema.parse(row.payload));
  }
  async createPendingResults(owner: OwnerScope, changeSetId: string, runId: string, artifacts: ArtifactRef[] = [], caseVersionIds?: string[], observations: CaseExecutionObservation[] = []): Promise<CaseHubResult[]> {
    await this.ready();
    const selected = caseVersionIds ? new Set(caseVersionIds) : undefined;
    const versions = (await this.versionsForChangeSet(owner, changeSetId)).filter(version => !selected || selected.has(version.id));
    return this.prisma.$transaction(async transaction => {
      const created: CaseHubResult[] = [];
      for (const version of versions) {
        const proposed = CaseHubCaseVersionSchema.parse({ ...version, status: "proposed" });
        await transaction.qaseyCaseVersionRecord.update({
          where: { applicationId_tenantId_id: { ...owner, id: version.id } },
          data: { status: "proposed", payload: proposed as unknown as Prisma.InputJsonValue },
        });
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
    if (current.reviewStatus !== "pending") throw new Error("Only pending results can be reviewed");
    if (review.verdict === "approve" && current.executionStatus !== "passed") throw new Error("Only passed results can be approved");
    const updated = CaseHubResultSchema.parse({
      ...current, reviewStatus: review.verdict === "approve" ? "approved" : review.verdict,
      reviewerId, ...(review.feedback ? { feedback: review.feedback } : {}), reviewedAt: this.now().toISOString(),
    });
    await this.prisma.$transaction(async transaction => {
      await transaction.qaseyCaseResultRecord.update({ where: { applicationId_tenantId_id: { ...owner, id: resultId } }, data: { reviewStatus: updated.reviewStatus, payload: updated as unknown as Prisma.InputJsonValue } });
      if (updated.reviewStatus === "approved") {
        const row = await transaction.qaseyCaseVersionRecord.findUniqueOrThrow({ where: { applicationId_tenantId_id: { ...owner, id: updated.caseVersionId } }, select: { payload: true } });
        const approved = CaseHubCaseVersionSchema.parse({ ...CaseHubCaseVersionSchema.parse(row.payload), status: "approved" });
        await transaction.qaseyCaseVersionRecord.update({ where: { applicationId_tenantId_id: { ...owner, id: updated.caseVersionId } }, data: { status: "approved", payload: approved as unknown as Prisma.InputJsonValue } });
      }
    });
    return updated;
  }
  async activateApprovedVersions(owner: OwnerScope, changeSetId: string): Promise<void> {
    await this.ready();
    const [versions, results] = await Promise.all([this.versionsForChangeSet(owner, changeSetId), this.listResults(owner, changeSetId)]);
    await this.prisma.$transaction(async transaction => {
      for (const version of versions) {
        const latest = results.filter(result => result.caseVersionId === version.id).at(-1);
        if (latest?.reviewStatus !== "approved") throw new Error(`Case ${version.caseId} is not approved`);
        const active = CaseHubCaseVersionSchema.parse({ ...version, status: "active" });
        await transaction.qaseyCaseVersionRecord.update({ where: { applicationId_tenantId_id: { ...owner, id: version.id } }, data: { status: "active", payload: active as unknown as Prisma.InputJsonValue } });
        const row = await transaction.qaseyCaseRecord.findUniqueOrThrow({ where: { applicationId_tenantId_id: { ...owner, id: version.caseId } }, select: { payload: true } });
        const current = CaseHubCaseSchema.parse(row.payload);
        const updated = CaseHubCaseSchema.parse({ ...current, activeVersionId: version.id, proposedVersionIds: current.proposedVersionIds.filter(id => id !== version.id), title: version.title, suitePath: version.suitePath, updatedAt: this.now().toISOString() });
        await transaction.qaseyCaseRecord.update({ where: { applicationId_tenantId_id: { ...owner, id: version.caseId } }, data: { activeVersionId: version.id, title: version.title, suitePath: version.suitePath, payload: updated as unknown as Prisma.InputJsonValue } });
      }
    });
  }
  async close(): Promise<void> {}
}

export function caseHubVersionToTestCase(version: CaseHubCaseVersion): TestCaseSpec {
  return {
    id: version.caseId,
    versionHash: version.contentHash,
    automationPath: version.automationPath,
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

const CHANGE_SET_TRANSITIONS: Record<CaseHubChangeSetStatus, readonly CaseHubChangeSetStatus[]> = {
  authoring: ["verifying", "blocked_product", "blocked_environment", "failed", "cancelled", "abandoned"],
  verifying: ["awaiting_review", "failed", "cancelled", "blocked_environment", "abandoned"],
  awaiting_review: ["revising", "blocked_product", "blocked_environment", "final_verifying", "cancelled", "abandoned"],
  revising: ["verifying", "failed", "cancelled", "abandoned"],
  blocked_product: ["verifying", "cancelled", "abandoned"],
  blocked_environment: ["verifying", "cancelled", "abandoned"],
  final_verifying: ["ready_to_merge", "awaiting_review", "failed", "cancelled", "abandoned"],
  ready_to_merge: ["merged", "abandoned"],
  merged: [], failed: [], cancelled: [], abandoned: [],
};

export function assertChangeSetTransition(from: CaseHubChangeSetStatus, to?: CaseHubChangeSetStatus): void {
  if (to && to !== from && !CHANGE_SET_TRANSITIONS[from].includes(to)) throw new Error(`Invalid Case Hub change set transition: ${from} -> ${to}`);
}

function boundedLimit(limit: number): number { return Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 100, 1), 500); }
function artifactsForCase(artifacts: ArtifactRef[], caseId: string, observedArtifactNames: string[] = []): ArtifactRef[] {
  const normalizedCaseId = caseId.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const observed = observedArtifactNames.map(name => name.replaceAll("\\", "/"));
  return artifacts.filter(artifact => {
    if (artifact.kind === "log" || artifact.kind === "report" || artifact.kind === "patch") return true;
    const artifactName = artifact.name.replaceAll("\\", "/");
    if (observed.some(name => artifactName.endsWith(name))) return true;
    return artifact.name.toLowerCase().replace(/[^a-z0-9]/gu, "").includes(normalizedCaseId);
  });
}
function caseSequence(id: string): number { return Number(id.slice("QASEY-".length)); }
function ownerPrefix(owner: OwnerScope): string { return `${owner.applicationId}\u0000${owner.tenantId}\u0000`; }
function ownerKey(owner: OwnerScope, id: string): string { return `${ownerPrefix(owner)}${id}`; }
function clone<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : structuredClone(value); }
