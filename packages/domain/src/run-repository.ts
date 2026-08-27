import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { E2ERunSchema, type E2ERun, type OwnerScope, type RunEvent, type RunStatus } from "../../contracts/src/index.ts";

export type RunPatch = Partial<Pick<E2ERun, "status" | "branch" | "baseSha" | "pullRequestUrl" | "error" | "artifacts" | "caseSnapshot" | "executionBrief" | "briefHash" | "repositoryExecution" | "traceId" | "amendments" | "codeTaskIds">>;

export class RunRevisionConflictError extends Error {
  readonly name = "RunRevisionConflictError";
  readonly code = "run_revision_conflict";

  constructor(
    readonly runId: string,
    readonly expectedRevision: number,
    readonly actualRevision?: number,
  ) {
    super(`Run ${runId} revision conflict: expected ${expectedRevision}, actual ${actualRevision ?? "unknown"}`);
  }
}

export class InvalidRunTransitionError extends Error {
  readonly name = "InvalidRunTransitionError";
  readonly code = "invalid_run_transition";

  constructor(readonly from: RunStatus, readonly to: RunStatus) {
    super(`Invalid run transition: ${from} -> ${to}`);
  }
}

export interface RunRepository {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  create(owner: OwnerScope, run: E2ERun): Promise<E2ERun>;
  get(owner: OwnerScope, id: string): Promise<E2ERun | undefined>;
  list(owner: OwnerScope, limit?: number): Promise<E2ERun[]>;
  listStale(before: Date, statuses: readonly RunStatus[], limit?: number): Promise<E2ERun[]>;
  heartbeat(owner: OwnerScope, id: string): Promise<void>;
  update(owner: OwnerScope, id: string, expectedRevision: number, patch: RunPatch): Promise<E2ERun>;
  addEvent(owner: OwnerScope, runId: string, type: string, message: string, metadata?: Record<string, unknown>): Promise<RunEvent>;
  events(owner: OwnerScope, runId: string): Promise<RunEvent[]>;
  close?(): Promise<void>;
}

export class InMemoryRunRepository implements RunRepository {
  readonly runs = new Map<string, E2ERun>();
  readonly runEvents = new Map<string, RunEvent[]>();
  readonly runHeartbeats = new Map<string, Date>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async create(owner: OwnerScope, run: E2ERun): Promise<E2ERun> {
    assertOwner(owner, run);
    const created = E2ERunSchema.parse(run);
    if (created.revision !== 1) throw new Error("New runs must start at revision 1");
    const key = ownerKey(owner, run.id);
    if (this.runs.has(key)) throw new Error(`Run ${run.id} already exists`);
    this.runs.set(key, structuredClone(created));
    this.runHeartbeats.set(key, this.now());
    return structuredClone(created);
  }

  async get(owner: OwnerScope, id: string): Promise<E2ERun | undefined> {
    const run = this.runs.get(ownerKey(owner, id));
    return run ? structuredClone(run) : undefined;
  }

  async list(owner: OwnerScope, limit = 100): Promise<E2ERun[]> {
    const prefix = `${owner.applicationId}\u0000${owner.tenantId}\u0000`;
    return [...this.runs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, run]) => structuredClone(run))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 500));
  }

  async listStale(before: Date, statuses: readonly RunStatus[], limit = 100): Promise<E2ERun[]> {
    const allowed = new Set(statuses);
    return [...this.runs.entries()]
      .filter(([key, run]) => allowed.has(run.status) && (this.runHeartbeats.get(key)?.getTime() ?? 0) < before.getTime())
      .map(([, run]) => structuredClone(run))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, Math.min(Math.max(limit, 1), 500));
  }

  async heartbeat(owner: OwnerScope, id: string): Promise<void> {
    const key = ownerKey(owner, id);
    if (!this.runs.has(key)) throw new Error(`Run ${id} not found`);
    this.runHeartbeats.set(key, this.now());
  }

  async update(owner: OwnerScope, id: string, expectedRevision: number, patch: RunPatch): Promise<E2ERun> {
    assertExpectedRevision(expectedRevision);
    const key = ownerKey(owner, id);
    const current = this.runs.get(key);
    if (!current) throw new Error(`Run ${id} not found`);
    assertMatchingRevision(id, expectedRevision, current.revision);
    assertPatchTransition(current, patch);
    const updated = E2ERunSchema.parse({
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
    });
    this.runs.set(key, updated);
    this.runHeartbeats.set(key, this.now());
    return structuredClone(updated);
  }

  async addEvent(owner: OwnerScope, runId: string, type: string, message: string, metadata: Record<string, unknown> = {}): Promise<RunEvent> {
    const key = ownerKey(owner, runId);
    if (!this.runs.has(key)) throw new Error(`Run ${runId} not found`);
    const event = { id: randomUUID(), runId, at: new Date().toISOString(), type, message, metadata };
    const events = this.runEvents.get(key) ?? [];
    events.push(event);
    this.runEvents.set(key, events);
    return structuredClone(event);
  }

  async events(owner: OwnerScope, runId: string): Promise<RunEvent[]> {
    return structuredClone(this.runEvents.get(ownerKey(owner, runId)) ?? []);
  }

  async close(): Promise<void> {}
}

export class PrismaRunRepository implements RunRepository {
  private initialized?: Promise<void>;

  constructor(private readonly prisma: PrismaClient) {}

  init(): Promise<void> {
    this.initialized ??= this.prisma.$connect();
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PrismaRunRepository has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async create(owner: OwnerScope, run: E2ERun): Promise<E2ERun> {
    assertOwner(owner, run);
    await this.ready();
    const created = E2ERunSchema.parse(run);
    if (created.revision !== 1) throw new Error("New runs must start at revision 1");
    await this.prisma.agentApplicationRun.create({ data: {
      applicationId: owner.applicationId,
      tenantId: owner.tenantId,
      id: run.id,
      revision: created.revision,
      payload: created as unknown as Prisma.InputJsonValue,
    } });
    return structuredClone(created);
  }

  async get(owner: OwnerScope, id: string): Promise<E2ERun | undefined> {
    await this.ready();
    const result = await this.prisma.agentApplicationRun.findUnique({
      where: { applicationId_tenantId_id: { applicationId: owner.applicationId, tenantId: owner.tenantId, id } },
      select: { payload: true, revision: true },
    });
    return result ? runFromRow(result) : undefined;
  }

  async list(owner: OwnerScope, limit = 100): Promise<E2ERun[]> {
    await this.ready();
    const result = await this.prisma.agentApplicationRun.findMany({
      where: { applicationId: owner.applicationId, tenantId: owner.tenantId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: Math.min(Math.max(limit, 1), 500),
      select: { payload: true, revision: true },
    });
    return result.map(runFromRow);
  }

  async listStale(before: Date, statuses: readonly RunStatus[], limit = 100): Promise<E2ERun[]> {
    await this.ready();
    if (statuses.length === 0) return [];
    const rows = await this.prisma.$queryRawUnsafe<Array<{ payload: Prisma.JsonValue; revision: number }>>(
      `SELECT payload,revision FROM agent_application_runs
       WHERE heartbeat_at < $1 AND payload->>'status'=ANY($2::text[])
       ORDER BY heartbeat_at ASC LIMIT $3`,
      before, [...statuses], Math.min(Math.max(limit, 1), 500),
    );
    return rows.map(runFromRow);
  }

  async heartbeat(owner: OwnerScope, id: string): Promise<void> {
    await this.ready();
    const count = await this.prisma.$executeRawUnsafe(
      `UPDATE agent_application_runs SET heartbeat_at=now()
       WHERE application_id=$1 AND tenant_id=$2 AND id=$3`,
      owner.applicationId, owner.tenantId, id,
    );
    if (count !== 1) throw new Error(`Run ${id} not found`);
  }

  async update(owner: OwnerScope, id: string, expectedRevision: number, patch: RunPatch): Promise<E2ERun> {
    assertExpectedRevision(expectedRevision);
    await this.ready();
    return this.prisma.$transaction(async transaction => {
      const row = await transaction.agentApplicationRun.findUnique({
        where: { applicationId_tenantId_id: { applicationId: owner.applicationId, tenantId: owner.tenantId, id } },
        select: { payload: true, revision: true },
      });
      if (!row) throw new Error(`Run ${id} not found`);
      assertMatchingRevision(id, expectedRevision, row.revision);
      const current = runFromRow(row);
      assertPatchTransition(current, patch);
      const now = new Date();
      const updated = E2ERunSchema.parse({
        ...current,
        ...patch,
        revision: expectedRevision + 1,
        updatedAt: now.toISOString(),
      });
      const result = await transaction.agentApplicationRun.updateMany({
        where: {
          applicationId: owner.applicationId,
          tenantId: owner.tenantId,
          id,
          revision: expectedRevision,
        },
        data: {
          payload: updated as unknown as Prisma.InputJsonValue,
          revision: { increment: 1 },
          updatedAt: now,
        },
      });
      if (result.count !== 1) throw new RunRevisionConflictError(id, expectedRevision);
      await transaction.$executeRawUnsafe(
        `UPDATE agent_application_runs SET heartbeat_at=$4
         WHERE application_id=$1 AND tenant_id=$2 AND id=$3`,
        owner.applicationId, owner.tenantId, id, now,
      );
      return structuredClone(updated);
    });
  }

  async addEvent(owner: OwnerScope, runId: string, type: string, message: string, metadata: Record<string, unknown> = {}): Promise<RunEvent> {
    await this.ready();
    const event = { id: randomUUID(), runId, at: new Date().toISOString(), type, message, metadata };
    await this.prisma.agentApplicationRunEvent.create({ data: {
      applicationId: owner.applicationId, tenantId: owner.tenantId,
      id: event.id, runId, payload: event as unknown as Prisma.InputJsonValue,
    } });
    return event;
  }

  async events(owner: OwnerScope, runId: string): Promise<RunEvent[]> {
    await this.ready();
    const result = await this.prisma.agentApplicationRunEvent.findMany({
      where: { applicationId: owner.applicationId, tenantId: owner.tenantId, runId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { payload: true },
    });
    return result.map(row => row.payload as unknown as RunEvent);
  }

  async close(): Promise<void> {}
}

function ownerKey(owner: OwnerScope, id: string): string {
  return `${owner.applicationId}\u0000${owner.tenantId}\u0000${id}`;
}

function assertOwner(owner: OwnerScope, run: E2ERun): void {
  if (run.applicationId !== owner.applicationId || run.tenantId !== owner.tenantId) {
    throw new Error("Run owner does not match repository owner scope");
  }
}

const allowedTransitions: Record<RunStatus, RunStatus[]> = {
  queued: ["preparing_workspace", "cancelled", "failed"],
  preparing_workspace: ["authoring", "cancelled", "failed"],
  authoring: ["author_running", "cancelled", "failed"],
  author_running: ["repairing", "clean_verifying", "cancelled", "failed"],
  repairing: ["preparing_workspace", "author_running", "cancelled", "failed"],
  clean_verifying: ["awaiting_qa", "cancelled", "failed"],
  awaiting_qa: ["repairing", "succeeded", "cancelled"],
  succeeded: [], failed: [], cancelled: [],
};

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!allowedTransitions[from].includes(to)) throw new InvalidRunTransitionError(from, to);
}

function assertPatchTransition(current: E2ERun, patch: RunPatch): void {
  if (patch.status && patch.status !== current.status) assertRunTransition(current.status, patch.status);
}

function assertExpectedRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError("expectedRevision must be a positive safe integer");
}

function assertMatchingRevision(id: string, expectedRevision: number, actualRevision: number): void {
  if (actualRevision !== expectedRevision) {
    throw new RunRevisionConflictError(id, expectedRevision, actualRevision);
  }
}

function runFromRow(row: { payload: Prisma.JsonValue; revision: number }): E2ERun {
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    throw new Error("Persisted run payload must be a JSON object");
  }
  return E2ERunSchema.parse({ ...row.payload, revision: row.revision });
}
