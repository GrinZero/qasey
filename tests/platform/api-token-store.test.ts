import { describe, expect, it } from "vitest";
import { InMemoryApiTokenStore } from "../../src/platform/auth/api-token-store.ts";
import { InMemoryPermissionStore, PermissionService } from "../../src/platform/auth/permission-store.ts";

describe("API token store", () => {
  it("returns the secret once and authenticates a scoped service principal", async () => {
    const store = new InMemoryApiTokenStore();
    const created = await store.create({
      tenantId: "tenant-1",
      name: "CI runner",
      scopes: ["qasey.runs.write", "qasey.runs.read", "qasey.runs.read"],
      createdBy: "admin-1",
    });

    expect(created.token).toMatch(/^qsy_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u);
    expect(created.record.prefix).toMatch(/^qsy_[0-9a-f]{8}$/u);
    expect(created.record.scopes).toEqual(["qasey.runs.read", "qasey.runs.write"]);
    expect(await store.list("tenant-1")).toEqual([expect.not.objectContaining({ token: expect.anything(), tokenHash: expect.anything() })]);

    const principal = await store.authenticate(created.token);
    expect(principal).toMatchObject({
      subjectId: `api-token:${created.record.id}`,
      tenantId: "tenant-1",
      roles: [],
      audience: "api",
      service: true,
      scopes: ["qasey.runs.read", "qasey.runs.write"],
      tokenId: created.record.id,
    });
    const permissions = new PermissionService(new InMemoryPermissionStore());
    await expect(permissions.authorize({
      principal: principal!, applicationId: "qasey", resourceType: "route", resourceId: "runs",
      action: "read", permission: "qasey.runs.read",
    })).resolves.toBe(true);
    await expect(permissions.authorize({
      principal: principal!, applicationId: "qasey", resourceType: "route", resourceId: "runs",
      action: "approve", permission: "qasey.runs.approve",
    })).resolves.toBe(false);
    expect((await store.list("tenant-1"))[0]?.lastUsedAt).toBeTruthy();
  });

  it("rejects changed, expired, and revoked tokens without crossing tenant boundaries", async () => {
    const store = new InMemoryApiTokenStore();
    const active = await store.create({
      tenantId: "tenant-1", name: "active", scopes: ["qasey.runs.read"], createdBy: "admin-1",
    });
    const expired = await store.create({
      tenantId: "tenant-1", name: "expired", scopes: ["qasey.runs.read"], createdBy: "admin-1",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const changed = `${active.token.slice(0, -1)}${active.token.endsWith("a") ? "b" : "a"}`;

    await expect(store.authenticate(changed)).resolves.toBeUndefined();
    await expect(store.authenticate(expired.token)).resolves.toBeUndefined();
    await expect(store.revoke("tenant-2", active.record.id)).resolves.toBe(false);
    await expect(store.authenticate(active.token)).resolves.toBeTruthy();
    await expect(store.revoke("tenant-1", active.record.id)).resolves.toBe(true);
    await expect(store.revoke("tenant-1", active.record.id)).resolves.toBe(false);
    await expect(store.authenticate(active.token)).resolves.toBeUndefined();
  });
});
