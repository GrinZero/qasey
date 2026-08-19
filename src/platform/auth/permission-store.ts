import { Pool } from "pg";
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

export class PostgresPermissionStore implements PermissionStore {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  init(): Promise<void> {
    this.initialized ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS platform_roles (
        tenant_id text NOT NULL,
        role_id text NOT NULL,
        PRIMARY KEY (tenant_id, role_id)
      );
      CREATE TABLE IF NOT EXISTS platform_role_permissions (
        tenant_id text NOT NULL,
        role_id text NOT NULL,
        permission text NOT NULL,
        PRIMARY KEY (tenant_id, role_id, permission),
        FOREIGN KEY (tenant_id, role_id) REFERENCES platform_roles(tenant_id, role_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS platform_subject_roles (
        tenant_id text NOT NULL,
        subject_id text NOT NULL,
        role_id text NOT NULL,
        PRIMARY KEY (tenant_id, subject_id, role_id),
        FOREIGN KEY (tenant_id, role_id) REFERENCES platform_roles(tenant_id, role_id) ON DELETE CASCADE
      );
    `).then(() => undefined);
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PostgresPermissionStore has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.pool.query("SELECT 1");
  }

  async permissionsForRoles(tenantId: string, roles: readonly string[]): Promise<ReadonlySet<string>> {
    if (roles.length === 0) return new Set();
    await this.ready();
    const result = await this.pool.query<{ permission: string }>(
      "SELECT permission FROM platform_role_permissions WHERE tenant_id = $1 AND role_id = ANY($2::text[])",
      [tenantId, roles],
    );
    return new Set(result.rows.map(row => row.permission));
  }

  async rolesForSubject(tenantId: string, subjectId: string): Promise<ReadonlySet<string>> {
    await this.ready();
    const result = await this.pool.query<{ role_id: string }>(
      "SELECT role_id FROM platform_subject_roles WHERE tenant_id = $1 AND subject_id = $2",
      [tenantId, subjectId],
    );
    return new Set(result.rows.map(row => row.role_id));
  }

  async grantRolePermission(tenantId: string, role: string, permission: string): Promise<void> {
    await this.grantRolePermissions(tenantId, role, [permission]);
  }

  async grantRolePermissions(tenantId: string, role: string, permissions: readonly string[]): Promise<void> {
    if (permissions.length === 0) return;
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO platform_roles(tenant_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [tenantId, role],
      );
      await client.query(
        `INSERT INTO platform_role_permissions(tenant_id, role_id, permission)
         SELECT $1, $2, permission FROM unnest($3::text[]) AS permission
         ON CONFLICT DO NOTHING`,
        [tenantId, role, [...new Set(permissions)]],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async bindSubjectRole(tenantId: string, subjectId: string, role: string): Promise<void> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO platform_roles(tenant_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [tenantId, role]);
      await client.query(
        "INSERT INTO platform_subject_roles(tenant_id, subject_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [tenantId, subjectId, role],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
