import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { OutboundMessage, QaseyRequestContext, TriggerEnvelope } from "../../contracts/src/index.ts";

export interface TriggerJob {
  id: string;
  envelope: TriggerEnvelope;
  request: QaseyRequestContext;
  attempts: number;
}

export interface TriggerQueue {
  enqueue(envelope: TriggerEnvelope, request: QaseyRequestContext): Promise<boolean>;
  claim(workerId: string): Promise<TriggerJob | undefined>;
  heartbeat(id: string, workerId: string): Promise<boolean>;
  complete(id: string, workerId: string): Promise<boolean>;
  fail(id: string, workerId: string, error: string, retryDelaySeconds?: number): Promise<boolean>;
}

export interface NotificationOutbox {
  publish(message: OutboundMessage): Promise<boolean>;
  claim(workerId: string): Promise<OutboundMessage | undefined>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string, retryDelaySeconds?: number): Promise<void>;
}

export class InMemoryTriggerQueue implements TriggerQueue {
  private readonly queued: TriggerJob[] = [];
  private readonly inflight = new Map<string, { job: TriggerJob; workerId: string }>();
  private readonly accepted = new Set<string>();

  async enqueue(envelope: TriggerEnvelope, request: QaseyRequestContext): Promise<boolean> {
    if (this.accepted.has(envelope.idempotencyKey)) return false;
    this.accepted.add(envelope.idempotencyKey);
    this.queued.push({ id: randomUUID(), envelope: structuredClone(envelope), request: structuredClone(request), attempts: 0 });
    return true;
  }

  async claim(workerId: string): Promise<TriggerJob | undefined> {
    const job = this.queued.shift();
    if (!job) return undefined;
    const claimed = { ...job, attempts: job.attempts + 1 };
    this.inflight.set(job.id, { job: claimed, workerId });
    return structuredClone(claimed);
  }

  async heartbeat(id: string, workerId: string): Promise<boolean> {
    return this.inflight.get(id)?.workerId === workerId;
  }

  async complete(id: string, workerId: string): Promise<boolean> {
    if (this.inflight.get(id)?.workerId !== workerId) return false;
    this.inflight.delete(id);
    return true;
  }

  async fail(id: string, workerId: string, _error: string, _retryDelaySeconds?: number): Promise<boolean> {
    const inflight = this.inflight.get(id);
    if (inflight?.workerId !== workerId) return false;
    this.inflight.delete(id);
    if (inflight.job.attempts < 3) this.queued.push(inflight.job);
    return true;
  }
}

export class InMemoryNotificationOutbox implements NotificationOutbox {
  private readonly queued: OutboundMessage[] = [];
  private readonly inflight = new Map<string, OutboundMessage>();
  private readonly accepted = new Set<string>();
  async publish(message: OutboundMessage): Promise<boolean> {
    if (this.accepted.has(message.idempotencyKey)) return false;
    this.accepted.add(message.idempotencyKey);
    this.queued.push(structuredClone(message));
    return true;
  }
  async claim(_workerId: string): Promise<OutboundMessage | undefined> {
    const message = this.queued.shift();
    if (message) this.inflight.set(message.id, message);
    return message;
  }
  async complete(id: string): Promise<void> { this.inflight.delete(id); }
  async fail(id: string, _error: string, _retryDelaySeconds?: number): Promise<void> {
    const message = this.inflight.get(id);
    this.inflight.delete(id);
    if (message) this.queued.push(message);
  }
}

export class PostgresTriggerQueue implements TriggerQueue {
  private readonly pool: Pool;
  private initialized?: Promise<void>;
  constructor(connectionString: string, private readonly leaseMs = 90_000) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.pool.query(`CREATE TABLE IF NOT EXISTS qasey_trigger_jobs (
      id uuid PRIMARY KEY,
      idempotency_key text UNIQUE NOT NULL,
      envelope jsonb NOT NULL,
      request jsonb NOT NULL,
      status text NOT NULL DEFAULT 'queued',
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      locked_by text,
      locked_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS qasey_trigger_jobs_claim_idx ON qasey_trigger_jobs(status, available_at, created_at);
    `).then(() => undefined);
    return this.initialized;
  }

  async enqueue(envelope: TriggerEnvelope, request: QaseyRequestContext): Promise<boolean> {
    await this.ensureInitialized();
    const result = await this.pool.query(
      `INSERT INTO qasey_trigger_jobs(id,idempotency_key,envelope,request) VALUES($1,$2,$3::jsonb,$4::jsonb)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [randomUUID(), envelope.idempotencyKey, JSON.stringify(envelope), JSON.stringify(request)],
    );
    return result.rowCount === 1;
  }

  async claim(workerId: string): Promise<TriggerJob | undefined> {
    await this.ensureInitialized();
    const result = await this.pool.query<{ id: string; envelope: TriggerEnvelope; request: QaseyRequestContext; attempts: number }>(`
      WITH next AS (
        SELECT id FROM qasey_trigger_jobs
        WHERE (status = 'queued' AND available_at <= now())
           OR (status = 'running' AND locked_at < now() - ($2 * interval '1 millisecond'))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE qasey_trigger_jobs j SET status='running', locked_by=$1, locked_at=now(), attempts=attempts+1, updated_at=now()
      FROM next WHERE j.id=next.id
      RETURNING j.id,j.envelope,j.request,j.attempts`, [workerId, this.leaseMs]);
    return result.rows[0];
  }

  async heartbeat(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE qasey_trigger_jobs SET locked_at=now(),updated_at=now() WHERE id=$1 AND status='running' AND locked_by=$2",
      [id, workerId],
    );
    return result.rowCount === 1;
  }

  async complete(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE qasey_trigger_jobs SET status='completed',locked_by=NULL,locked_at=NULL,updated_at=now() WHERE id=$1 AND status='running' AND locked_by=$2",
      [id, workerId],
    );
    return result.rowCount === 1;
  }

  async fail(id: string, workerId: string, error: string, retryDelaySeconds = 30): Promise<boolean> {
    const result = await this.pool.query(`UPDATE qasey_trigger_jobs SET
      status=CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
      available_at=now()+($2 * interval '1 second'), last_error=$3, locked_by=NULL, locked_at=NULL, updated_at=now()
      WHERE id=$1 AND status='running' AND locked_by=$4`, [id, retryDelaySeconds, error.slice(0, 4000), workerId]);
    return result.rowCount === 1;
  }
}

export class PostgresNotificationOutbox implements NotificationOutbox {
  private readonly pool: Pool;
  private initialized?: Promise<void>;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 5 }); }
  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.pool.query(`CREATE TABLE IF NOT EXISTS qasey_notification_outbox (
      id text PRIMARY KEY,
      idempotency_key text UNIQUE NOT NULL,
      payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'queued',
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      locked_by text,
      locked_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS qasey_notification_claim_idx ON qasey_notification_outbox(status, available_at, created_at);
    ALTER TABLE qasey_notification_outbox ADD COLUMN IF NOT EXISTS locked_at timestamptz;
    `).then(() => undefined);
    return this.initialized;
  }
  async publish(message: OutboundMessage): Promise<boolean> {
    await this.ensureInitialized();
    const result = await this.pool.query(
      "INSERT INTO qasey_notification_outbox(id,idempotency_key,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(idempotency_key) DO NOTHING",
      [message.id, message.idempotencyKey, JSON.stringify(message)],
    );
    return result.rowCount === 1;
  }
  async claim(workerId: string): Promise<OutboundMessage | undefined> {
    await this.ensureInitialized();
    const result = await this.pool.query<{ payload: OutboundMessage }>(`
      WITH next AS (
        SELECT id FROM qasey_notification_outbox
        WHERE (status='queued' AND available_at<=now())
           OR (status='running' AND locked_at < now() - interval '15 minutes')
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE qasey_notification_outbox o SET status='running',locked_by=$1,locked_at=now(),attempts=attempts+1,updated_at=now()
      FROM next WHERE o.id=next.id RETURNING o.payload`, [workerId]);
    return result.rows[0]?.payload;
  }
  async complete(id: string): Promise<void> {
    await this.pool.query("UPDATE qasey_notification_outbox SET status='completed',updated_at=now() WHERE id=$1", [id]);
  }
  async fail(id: string, error: string, retryDelaySeconds = 30): Promise<void> {
    await this.pool.query(`UPDATE qasey_notification_outbox SET
      status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
      available_at=now()+($2 * interval '1 second'),last_error=$3,locked_by=NULL,locked_at=NULL,updated_at=now() WHERE id=$1`,
      [id, retryDelaySeconds, error.slice(0, 4000)]);
  }
}
