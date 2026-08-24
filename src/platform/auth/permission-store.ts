import type { PrismaClient } from "@prisma/client";
import type { OAuthPrincipal } from "./oauth-principal.ts";

export interface PermissionCheck {
  principal: OAuthPrincipal;
  applicationId: string;
  resourceType: string;
  resourceId: string;
  action: string;
  permission: string;
}

export interface PermissionStore {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  permissionsForRoles(tenantId: string, roles: readonly string[]): Promise<ReadonlySet<string>>;
  rolesForSubject(tenantId: string, subjectId: string): Promise<ReadonlySet<string>>;
  grantRolePermissions?(tenantId: string, role: string, permissions: readonly string[]): Promise<void>;
  grantRolePermission?(tenantId: string, role: string, permission: string): Promise<void>;
  bindSubjectRole?(tenantId: string, subjectId: string, role: string): Promise<void>;
  close?(): Promise<void>;
}

export class PermissionService {
  constructor(private readonly store: PermissionStore) {}

  async authorize(check: PermissionCheck): Promise<boolean> {
    if (check.principal.roles.includes("platform-admin")) return true;
    if (check.principal.tenantId !== check.principal.tenantId.trim()) return false;
    if (check.principal.scopes) {
      return check.principal.scopes.includes("*") || check.principal.scopes.includes(check.permission);
    }
    const boundRoles = await this.store.rolesForSubject(check.principal.tenantId, check.principal.subjectId);
    const permissions = await this.store.permissionsForRoles(check.principal.tenantId, [...check.principal.roles, ...boundRoles]);
    return permissions.has("*") || permissions.has(check.permission);
  }

  async grantRolePermission(tenantId: string, role: string, permission: string): Promise<void> {
    await this.grantRolePermissions(tenantId, role, [permission]);
  }

  async grantRolePermissions(tenantId: string, role: string, permissions: readonly string[]): Promise<void> {
    if (permissions.length === 0) return;
    if (this.store.grantRolePermissions) {
      await this.store.grantRolePermissions(tenantId, role, permissions);
      return;
    }
    if (!this.store.grantRolePermission) throw new Error("Permission store does not support mutations");
    await Promise.all(permissions.map(permission => this.store.grantRolePermission!(tenantId, role, permission)));
  }

  async bindSubjectRole(tenantId: string, subjectId: string, role: string): Promise<void> {
    if (!this.store.bindSubjectRole) throw new Error("Permission store does not support mutations");
    await this.store.bindSubjectRole(tenantId, subjectId, role);
  }
}

export class InMemoryPermissionStore implements PermissionStore {
  private readonly rolePermissions = new Map<string, Set<string>>();
  private readonly subjectRoles = new Map<string, Set<string>>();

  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  grant(tenantId: string, role: string, ...permissions: string[]): void {
    const key = `${tenantId}:${role}`;
    const values = this.rolePermissions.get(key) ?? new Set<string>();
    for (const permission of permissions) values.add(permission);
    this.rolePermissions.set(key, values);
  }

  async grantRolePermission(tenantId: string, role: string, permission: string): Promise<void> {
    this.grant(tenantId, role, permission);
  }

  async grantRolePermissions(tenantId: string, role: string, permissions: readonly string[]): Promise<void> {
    this.grant(tenantId, role, ...permissions);
  }

  async permissionsForRoles(tenantId: string, roles: readonly string[]): Promise<ReadonlySet<string>> {
    const permissions = new Set<string>();
    for (const role of roles) {
      for (const permission of this.rolePermissions.get(`${tenantId}:${role}`) ?? []) permissions.add(permission);
    }
    return permissions;
  }

  async rolesForSubject(tenantId: string, subjectId: string): Promise<ReadonlySet<string>> {
    return new Set(this.subjectRoles.get(`${tenantId}:${subjectId}`) ?? []);
  }

  async bindSubjectRole(tenantId: string, subjectId: string, role: string): Promise<void> {
    const key = `${tenantId}:${subjectId}`;
    const roles = this.subjectRoles.get(key) ?? new Set<string>();
    roles.add(role);
    this.subjectRoles.set(key, roles);
  }

  async close(): Promise<void> {}

}

export class PrismaPermissionStore implements PermissionStore {
  private initialized?: Promise<void>;

  constructor(private readonly prisma: PrismaClient) {}

  init(): Promise<void> {
    this.initialized ??= this.prisma.$connect();
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PrismaPermissionStore has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async permissionsForRoles(tenantId: string, roles: readonly string[]): Promise<ReadonlySet<string>> {
    if (roles.length === 0) return new Set();
    await this.ready();
    const result = await this.prisma.platformRolePermission.findMany({
      where: { tenantId, roleId: { in: [...roles] } }, select: { permission: true },
    });
    return new Set(result.map(row => row.permission));
  }

  async rolesForSubject(tenantId: string, subjectId: string): Promise<ReadonlySet<string>> {
    await this.ready();
    const result = await this.prisma.platformSubjectRole.findMany({
      where: { tenantId, subjectId }, select: { roleId: true },
    });
    return new Set(result.map(row => row.roleId));
  }

  async grantRolePermission(tenantId: string, role: string, permission: string): Promise<void> {
    await this.grantRolePermissions(tenantId, role, [permission]);
  }

  async grantRolePermissions(tenantId: string, role: string, permissions: readonly string[]): Promise<void> {
    if (permissions.length === 0) return;
    await this.ready();
    const uniquePermissions = [...new Set(permissions)];
    await this.prisma.$transaction(async tx => {
      await tx.platformRole.upsert({
        where: { tenantId_roleId: { tenantId, roleId: role } },
        create: { tenantId, roleId: role }, update: {},
      });
      await tx.platformRolePermission.createMany({
        data: uniquePermissions.map(permission => ({ tenantId, roleId: role, permission })),
        skipDuplicates: true,
      });
    });
  }

  async bindSubjectRole(tenantId: string, subjectId: string, role: string): Promise<void> {
    await this.ready();
    await this.prisma.$transaction(async tx => {
      await tx.platformRole.upsert({
        where: { tenantId_roleId: { tenantId, roleId: role } },
        create: { tenantId, roleId: role }, update: {},
      });
      await tx.platformSubjectRole.upsert({
        where: { tenantId_subjectId_roleId: { tenantId, subjectId, roleId: role } },
        create: { tenantId, subjectId, roleId: role }, update: {},
      });
    });
  }

  async close(): Promise<void> {
    // The shared Prisma client is owned by the runtime lifecycle.
  }
}
