import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { ArtifactRef, E2ERun, RunEvent, RunStatus } from "../../contracts/src/index.ts";

export interface RunRepository {
  create(run: E2ERun): Promise<E2ERun>;
  get(id: string): Promise<E2ERun | undefined>;
  update(id: string, patch: Partial<Pick<E2ERun, "status" | "branch" | "pullRequestUrl" | "error" | "artifacts">>): Promise<E2ERun>;
  addEvent(runId: string, type: string, message: string, metadata?: Record<string, unknown>): Promise<RunEvent>;
  events(runId: string): Promise<RunEvent[]>;
}

export class InMemoryRunRepository implements RunRepository {
  readonly runs = new Map<string, E2ERun>();
  readonly runEvents = new Map<string, RunEvent[]>();

  async create(run: E2ERun): Promise<E2ERun> {
    if (this.runs.has(run.id)) throw new Error(`Run ${run.id} already exists`);
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  async get(id: string): Promise<E2ERun | undefined> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  async update(id: string, patch: Partial<Pick<E2ERun, "status" | "branch" | "pullRequestUrl" | "error" | "artifacts">>): Promise<E2ERun> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`Run ${id} not found`);
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.runs.set(id, updated);
    return structuredClone(updated);
  }

  async addEvent(runId: string, type: string, message: string, metadata: Record<string, unknown> = {}): Promise<RunEvent> {
    if (!this.runs.has(runId)) throw new Error(`Run ${runId} not found`);
    const event = { id: randomUUID(), runId, at: new Date().toISOString(), type, message, metadata };
    const events = this.runEvents.get(runId) ?? [];
    events.push(event);
    this.runEvents.set(runId, events);
    return structuredClone(event);
  }

  async events(runId: string): Promise<RunEvent[]> {
    return structuredClone(this.runEvents.get(runId) ?? []);
  }
}

export class PostgresRunRepository implements RunRepository {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS qasey_runs (
        id text PRIMARY KEY,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS qasey_run_events (
        id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES qasey_runs(id) ON DELETE CASCADE,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS qasey_run_events_run_id_idx ON qasey_run_events(run_id, created_at);
    `).then(() => undefined);
    return this.initialized;
  }

  async create(run: E2ERun): Promise<E2ERun> {
    await this.ensureInitialized();
    await this.pool.query("INSERT INTO qasey_runs(id, payload) VALUES ($1, $2::jsonb)", [run.id, JSON.stringify(run)]);
    return structuredClone(run);
  }

  async get(id: string): Promise<E2ERun | undefined> {
    await this.ensureInitialized();
    const result = await this.pool.query<{ payload: E2ERun }>("SELECT payload FROM qasey_runs WHERE id = $1", [id]);
    return result.rows[0]?.payload;
  }

  async update(id: string, patch: Partial<Pick<E2ERun, "status" | "branch" | "pullRequestUrl" | "error" | "artifacts">>): Promise<E2ERun> {
    const current = await this.get(id);
    if (!current) throw new Error(`Run ${id} not found`);
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.pool.query("UPDATE qasey_runs SET payload = $2::jsonb, updated_at = now() WHERE id = $1", [id, JSON.stringify(updated)]);
    return updated;
  }

  async addEvent(runId: string, type: string, message: string, metadata: Record<string, unknown> = {}): Promise<RunEvent> {
    await this.ensureInitialized();
    const event = { id: randomUUID(), runId, at: new Date().toISOString(), type, message, metadata };
    await this.pool.query("INSERT INTO qasey_run_events(id, run_id, payload) VALUES ($1, $2, $3::jsonb)", [event.id, runId, JSON.stringify(event)]);
    return event;
  }

  async events(runId: string): Promise<RunEvent[]> {
    await this.ensureInitialized();
    const result = await this.pool.query<{ payload: RunEvent }>("SELECT payload FROM qasey_run_events WHERE run_id = $1 ORDER BY created_at, id", [runId]);
    return result.rows.map(row => row.payload);
  }
}

export interface EventInbox { accept(key: string): Promise<boolean>; }

export class InMemoryEventInbox implements EventInbox {
  private readonly keys = new Set<string>();
  async accept(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
}

export class PostgresEventInbox implements EventInbox {
  private readonly pool: Pool;
  private initialized?: Promise<void>;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 5 }); }
  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.pool.query(`CREATE TABLE IF NOT EXISTS qasey_event_inbox (
      idempotency_key text PRIMARY KEY,
      accepted_at timestamptz NOT NULL DEFAULT now()
    )`).then(() => undefined);
    return this.initialized;
  }
  async accept(key: string): Promise<boolean> {
    await this.ensureInitialized();
    const result = await this.pool.query("INSERT INTO qasey_event_inbox(idempotency_key) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
    return result.rowCount === 1;
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
