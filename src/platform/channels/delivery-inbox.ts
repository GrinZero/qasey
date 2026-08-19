import { Pool } from "pg";
import type { OwnerScope } from "../../../packages/contracts/src/index.ts";

export interface ChannelDeliveryInbox {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  accept(owner: OwnerScope, deliveryId: string): Promise<boolean>;
  close?(): Promise<void>;
}

export class InMemoryChannelDeliveryInbox implements ChannelDeliveryInbox {
  private readonly keys = new Set<string>();

  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async accept(owner: OwnerScope, deliveryId: string): Promise<boolean> {
    const key = `${owner.applicationId}\u0000${owner.tenantId}\u0000${deliveryId}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }

  async close(): Promise<void> {}
}

export class PostgresChannelDeliveryInbox implements ChannelDeliveryInbox {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 5 }); }

  init(): Promise<void> {
    this.initialized ??= this.pool.query(`CREATE TABLE IF NOT EXISTS platform_channel_deliveries (
      application_id text NOT NULL,
      tenant_id text NOT NULL,
      delivery_id text NOT NULL,
      accepted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (application_id, tenant_id, delivery_id)
    )`).then(() => undefined);
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PostgresChannelDeliveryInbox has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.pool.query("SELECT 1");
  }

  async accept(owner: OwnerScope, deliveryId: string): Promise<boolean> {
    await this.ready();
    const result = await this.pool.query(
      `INSERT INTO platform_channel_deliveries(application_id, tenant_id, delivery_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [owner.applicationId, owner.tenantId, deliveryId],
    );
    return result.rowCount === 1;
  }

  async close(): Promise<void> { await this.pool.end(); }
}
