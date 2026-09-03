import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { OwnerScope } from "../../../packages/contracts/src/index.ts";
import type { E2EFixtureLease, E2EFixtureLeaseProvider } from "../../../packages/e2e/src/index.ts";
import type { BuildMetadata } from "./build-metadata.ts";

interface FixtureLeaseRecord {
  id: string;
  owner: string;
  organizationId: string;
  userId: string;
  sessionId: string;
  expiresAt: string;
}

export interface CreatedFixtureLease extends FixtureLeaseRecord {
  sessionToken: string;
}

export const E2E_FIXTURE_ROLE = "qasey-e2e-fixture-user";
export const E2E_FIXTURE_PERMISSIONS = [
  "platform.admin-ui.access",
  "qasey.agent.execute",
  "qasey.e2e.execute",
  "qasey.runs.read",
  "qasey.runs.write",
  "qasey.cases.read",
  "qasey.cases.write",
  "qasey.results.read",
  "qasey.sandbox.use",
] as const;

export class E2EFixtureLeaseService implements E2EFixtureLeaseProvider {
  private readonly memoryLeases = new Map<string, FixtureLeaseRecord>();

  constructor(
    private readonly metadata: BuildMetadata,
    private readonly database?: PrismaClient,
  ) {}

  version() {
    return {
      sourceSha: this.metadata.sourceSha,
      environmentVersion: this.metadata.sourceSha.slice(0, 12),
      fixtureApi: 1 as const,
    };
  }

  async healthCheck(): Promise<void> {
    if (!this.database) throw new Error("Persistent database-backed fixture leases are required for real E2E");
    await this.database.$queryRaw`SELECT 1`;
  }

  async acquire(input: { owner: OwnerScope; runId: string; expectedSourceSha: string; baseUrl: string }): Promise<E2EFixtureLease> {
    if (this.metadata.sourceSha !== input.expectedSourceSha) {
      throw new Error(`environment_version_mismatch: expected ${input.expectedSourceSha}, received ${this.metadata.sourceSha}`);
    }
    const owner = `run:${input.owner.applicationId}:${input.owner.tenantId}:${input.runId}`;
    const lease = await this.create(owner, 1_800);
    return {
      id: lease.id,
      baseUrl: input.baseUrl.replace(/\/$/u, ""),
      sourceSha: this.metadata.sourceSha,
      sessionToken: lease.sessionToken,
    };
  }

  async release(lease: E2EFixtureLease): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.deleteById(lease.id);
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure instanceof Error ? failure : new Error("Fixture lease cleanup failed");
  }

  async create(owner: string, ttlSeconds: number): Promise<CreatedFixtureLease> {
    await this.cleanupExpired(owner);
    const id = randomUUID();
    const userId = randomUUID();
    const sessionId = randomUUID();
    const organizationId = `e2e-${id}`;
    const sessionToken = `qsy_session_${sessionId}_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    const lease: FixtureLeaseRecord = {
      id,
      owner,
      organizationId,
      userId,
      sessionId,
      expiresAt: expiresAt.toISOString(),
    };
    if (this.database) {
      await this.database.$transaction(async transaction => {
        await transaction.platformOrganization.create({ data: { id: organizationId, slug: organizationId, displayName: `E2E ${id}` } });
        await transaction.platformUser.create({ data: { id: userId, displayName: "Qasey E2E User" } });
        await transaction.platformUserIdentity.create({
          data: {
            provider: "password",
            providerSubject: `qasey-e2e-${id}`,
            userId,
            email: `e2e-${id}@example.test`,
            emailVerified: true,
          },
        });
        await transaction.platformOrganizationMembership.create({ data: { organizationId, userId, status: "active" } });
        await transaction.platformBrowserSession.create({
          data: { id: sessionId, organizationId, userId, tokenHash: createHash("sha256").update(sessionToken).digest(), expiresAt },
        });
        await transaction.platformRole.create({ data: { tenantId: organizationId, roleId: E2E_FIXTURE_ROLE } });
        await transaction.platformRolePermission.createMany({
          data: E2E_FIXTURE_PERMISSIONS.map(permission => ({ tenantId: organizationId, roleId: E2E_FIXTURE_ROLE, permission })),
        });
        await transaction.platformSubjectRole.create({ data: { tenantId: organizationId, subjectId: userId, roleId: E2E_FIXTURE_ROLE } });
        await transaction.qaseyE2EFixtureLease.create({ data: { id, owner, organizationId, userId, sessionId, expiresAt } });
      });
    } else {
      this.memoryLeases.set(id, lease);
    }
    return { ...lease, sessionToken };
  }

  async deleteForOwner(owner: string, id: string): Promise<"deleted" | "forbidden"> {
    const lease = await this.find(id);
    if (!lease) return "deleted";
    if (lease.owner !== owner) return "forbidden";
    await this.deleteById(id);
    return "deleted";
  }

  async isActiveFixtureUser(organizationId: string, userId: string): Promise<boolean> {
    const now = new Date();
    if (!this.database) {
      return [...this.memoryLeases.values()].some(lease => lease.organizationId === organizationId
        && lease.userId === userId && new Date(lease.expiresAt) > now);
    }
    return Boolean(await this.database.qaseyE2EFixtureLease.findFirst({
      where: { organizationId, userId, expiresAt: { gt: now } },
      select: { id: true },
    }));
  }

  private async cleanupExpired(_owner: string): Promise<void> {
    const now = new Date();
    if (!this.database) {
      for (const [id, lease] of this.memoryLeases) {
        if (new Date(lease.expiresAt) <= now) this.memoryLeases.delete(id);
      }
      return;
    }
    const expired = await this.database.qaseyE2EFixtureLease.findMany({ where: { expiresAt: { lte: now } } });
    for (const lease of expired) await this.deleteById(lease.id);
  }

  private async find(id: string): Promise<FixtureLeaseRecord | undefined> {
    if (!this.database) return this.memoryLeases.get(id);
    const lease = await this.database.qaseyE2EFixtureLease.findUnique({ where: { id } });
    return lease ? { ...lease, expiresAt: lease.expiresAt.toISOString() } : undefined;
  }

  private async deleteById(id: string): Promise<void> {
    const lease = await this.find(id);
    if (!lease) return;
    if (!this.database) {
      this.memoryLeases.delete(id);
      return;
    }
    await this.database.$transaction(async transaction => {
      await transaction.qaseyE2EFixtureLease.delete({ where: { id: lease.id } });
      await transaction.platformRole.deleteMany({ where: { tenantId: lease.organizationId } });
      await transaction.platformOrganization.delete({ where: { id: lease.organizationId } });
      await transaction.platformUser.delete({ where: { id: lease.userId } });
    });
  }
}
