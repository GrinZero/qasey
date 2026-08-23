import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { E2ERun, OwnerScope, RunEvent, RunStatus } from "../../contracts/src/index.ts";

export interface RunRepository {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  create(owner: OwnerScope, run: E2ERun): Promise<E2ERun>;
  get(owner: OwnerScope, id: string): Promise<E2ERun | undefined>;
  list(owner: OwnerScope, limit?: number): Promise<E2ERun[]>;
  update(owner: OwnerScope, id: string, patch: Partial<Pick<E2ERun, "status" | "branch" | "baseSha" | "pullRequestUrl" | "error" | "artifacts">>): Promise<E2ERun>;
  addEvent(owner: OwnerScope, runId: string, type: string, message: string, metadata?: Record<string, unknown>): Promise<RunEvent>;
  events(owner: OwnerScope, runId: string): Promise<RunEvent[]>;
  close?(): Promise<void>;
}

export class InMemoryRunRepository implements RunRepository {
  readonly runs = new Map<string, E2ERun>();
  readonly runEvents = new Map<string, RunEvent[]>();

  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async create(owner: OwnerScope, run: E2ERun): Promise<E2ERun> {
    assertOwner(owner, run);
    const key = ownerKey(owner, run.id);
    if (this.runs.has(key)) throw new Error(`Run ${run.id} already exists`);
    this.runs.set(key, structuredClone(run));
    return structuredClone(run);
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

  async update(owner: OwnerScope, id: string, patch: Partial<Pick<E2ERun, "status" | "branch" | "baseSha" | "pullRequestUrl" | "error" | "artifacts">>): Promise<E2ERun> {
    const key = ownerKey(owner, id);
    const current = this.runs.get(key);
    if (!current) throw new Error(`Run ${id} not found`);
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.runs.set(key, updated);
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

export class PostgresRunRepository implements RunRepository {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  init(): Promise<void> {
    this.initialized ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_application_runs (
        application_id text NOT NULL,
        tenant_id text NOT NULL,
        id text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (application_id, tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS agent_application_run_events (
        application_id text NOT NULL,
        tenant_id text NOT NULL,
        id text NOT NULL,
        run_id text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (application_id, tenant_id, id),
        FOREIGN KEY (application_id, tenant_id, run_id)
          REFERENCES agent_application_runs(application_id, tenant_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS agent_application_run_events_owner_idx
        ON agent_application_run_events(application_id, tenant_id, run_id, created_at);
    `).then(() => undefined);
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PostgresRunRepository has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.pool.query("SELECT 1");
  }

  async create(owner: OwnerScope, run: E2ERun): Promise<E2ERun> {
    assertOwner(owner, run);
    await this.ready();
    await this.pool.query(
      "INSERT INTO agent_application_runs(application_id, tenant_id, id, payload) VALUES ($1, $2, $3, $4::jsonb)",
      [owner.applicationId, owner.tenantId, run.id, JSON.stringify(run)],
    );
    return structuredClone(run);
  }

  async get(owner: OwnerScope, id: string): Promise<E2ERun | undefined> {
    await this.ready();
    const result = await this.pool.query<{ payload: E2ERun }>(
      "SELECT payload FROM agent_application_runs WHERE application_id = $1 AND tenant_id = $2 AND id = $3",
      [owner.applicationId, owner.tenantId, id],
    );
    return result.rows[0]?.payload;
  }

  async list(owner: OwnerScope, limit = 100): Promise<E2ERun[]> {
    await this.ready();
    const result = await this.pool.query<{ payload: E2ERun }>(
      `SELECT payload FROM agent_application_runs
       WHERE application_id = $1 AND tenant_id = $2
       ORDER BY created_at DESC, id LIMIT $3`,
      [owner.applicationId, owner.tenantId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map(row => row.payload);
  }

  async update(owner: OwnerScope, id: string, patch: Partial<Pick<E2ERun, "status" | "branch" | "baseSha" | "pullRequestUrl" | "error" | "artifacts">>): Promise<E2ERun> {
    const current = await this.get(owner, id);
    if (!current) throw new Error(`Run ${id} not found`);
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.pool.query(
      "UPDATE agent_application_runs SET payload = $4::jsonb, updated_at = now() WHERE application_id = $1 AND tenant_id = $2 AND id = $3",
      [owner.applicationId, owner.tenantId, id, JSON.stringify(updated)],
    );
    return updated;
  }

  async addEvent(owner: OwnerScope, runId: string, type: string, message: string, metadata: Record<string, unknown> = {}): Promise<RunEvent> {
    await this.ready();
    const event = { id: randomUUID(), runId, at: new Date().toISOString(), type, message, metadata };
    await this.pool.query(
      "INSERT INTO agent_application_run_events(application_id, tenant_id, id, run_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [owner.applicationId, owner.tenantId, event.id, runId, JSON.stringify(event)],
    );
    return event;
  }

  async events(owner: OwnerScope, runId: string): Promise<RunEvent[]> {
    await this.ready();
    const result = await this.pool.query<{ payload: RunEvent }>(
      "SELECT payload FROM agent_application_run_events WHERE application_id = $1 AND tenant_id = $2 AND run_id = $3 ORDER BY created_at, id",
      [owner.applicationId, owner.tenantId, runId],
    );
    return result.rows.map(row => row.payload);
  }

  async close(): Promise<void> { await this.pool.end(); }
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
  if (!allowedTransitions[from].includes(to)) throw new Error(`Invalid run transition: ${from} -> ${to}`);
}
