import type { PrismaClient } from "@prisma/client";
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

export class PrismaChannelDeliveryInbox implements ChannelDeliveryInbox {
  private initialized?: Promise<void>;

  constructor(private readonly prisma: PrismaClient) {}

  init(): Promise<void> {
    this.initialized ??= this.prisma.$connect();
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PrismaChannelDeliveryInbox has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async accept(owner: OwnerScope, deliveryId: string): Promise<boolean> {
    await this.ready();
    try {
      await this.prisma.platformChannelDelivery.create({ data: {
        applicationId: owner.applicationId, tenantId: owner.tenantId, deliveryId,
      } });
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return false;
      throw error;
    }
  }

  async close(): Promise<void> {}
}
