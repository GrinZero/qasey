import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActiveMembershipRequiredError,
  IdentityAlreadyLinkedError,
  InMemoryOrganizationStore,
  OrganizationInvitationResolutionError,
  PasswordIdentityAlreadyExistsError,
  PrismaOrganizationStore,
  VerifiedDomainConflictError,
} from "../../src/platform/auth/organization-store.ts";

const NOW = new Date("2026-08-26T08:00:00.000Z");
const EXPIRES_AT = "2026-08-26T09:00:00.000Z";

describe("InMemoryOrganizationStore", () => {
  it("rejects membership writes outside the trusted owner scope and keeps bootstrap grants active-only", async () => {
    const store = memoryStore();
    const alpha = await store.createOrganization({ slug: "scope-alpha", displayName: "Scope Alpha" });
    const beta = await store.createOrganization({ slug: "scope-beta", displayName: "Scope Beta" });
    const user = await store.createUser({ displayName: "Scoped user" });

    await expect(store.updateMembershipStatus(owner(alpha.id), {
      organizationId: beta.id,
      userId: user.id,
      status: "suspended",
    })).rejects.toMatchObject({ code: "organization_scope_mismatch" });
    await expect(store.updateMembershipStatus(owner(beta.id), {
      organizationId: beta.id,
      userId: user.id,
      status: "active",
    })).rejects.toMatchObject({ code: "organization_membership_not_found" });
    await expect(store.resolveMembership(beta.id, user.id)).resolves.toBeUndefined();

    await expect(store.grantBootstrapMembership({ organizationId: beta.id, userId: user.id }))
      .resolves.toMatchObject({ organizationId: beta.id, userId: user.id, status: "active" });
    await expect(store.updateMembershipStatus(owner(alpha.id), {
      organizationId: beta.id,
      userId: user.id,
      status: "removed",
    })).rejects.toMatchObject({ code: "organization_scope_mismatch" });
    await expect(store.resolveActiveMembership(beta.id, user.id)).resolves.toMatchObject({ status: "active" });
  });

  it("uses verified domains only for discovery and requires an explicit active membership", async () => {
    const store = memoryStore();
    const organization = await store.createOrganization({ slug: "Acme-QA", displayName: "Acme QA" });
    const user = await store.createUser({ displayName: "QA User" });
    await store.linkIdentity({
      userId: user.id,
      provider: "google",
      subject: "google-user-1",
      email: "qa.user@Acme.Example",
      emailVerified: true,
    });
    await store.verifyDomain({ organizationId: organization.id, domain: "ACME.EXAMPLE" });

    await expect(store.discoverOrganizationsForIdentity("google", "google-user-1"))
      .resolves.toEqual([expect.objectContaining({ id: organization.id, slug: "acme-qa" })]);
    await expect(store.resolveActiveMembership(organization.id, user.id)).resolves.toBeUndefined();
    await expect(store.createBrowserSession({
      organizationId: organization.id,
      userId: user.id,
      expiresAt: EXPIRES_AT,
    })).rejects.toBeInstanceOf(ActiveMembershipRequiredError);

    await store.grantBootstrapMembership({ organizationId: organization.id, userId: user.id });
    const created = await store.createBrowserSession({
      organizationId: organization.id,
      userId: user.id,
      expiresAt: EXPIRES_AT,
    });

    expect(created.token).toMatch(/^qsy_session_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u);
    expect(created.session).not.toHaveProperty("token");
    expect(created.session).not.toHaveProperty("tokenHash");
    await expect(store.authenticateBrowserSession(created.token)).resolves.toMatchObject({
      session: { id: created.session.id, organizationId: organization.id, userId: user.id },
      membership: { status: "active" },
      user: { id: user.id },
    });
  });

  it("resolves only active memberships and permanently revokes sessions on suspension or removal", async () => {
    const store = memoryStore();
    const organization = await store.createOrganization({ slug: "quality", displayName: "Quality" });
    const secondOrganization = await store.createOrganization({ slug: "quality-two", displayName: "Quality Two" });
    const user = await store.createUser({ displayName: "Member" });
    await store.grantBootstrapMembership({ organizationId: organization.id, userId: user.id });
    await store.grantBootstrapMembership({ organizationId: secondOrganization.id, userId: user.id });
    const first = await store.createBrowserSession({ organizationId: organization.id, userId: user.id, expiresAt: EXPIRES_AT });
    const secondOrganizationSession = await store.createBrowserSession({
      organizationId: secondOrganization.id,
      userId: user.id,
      expiresAt: EXPIRES_AT,
    });

    await store.updateMembershipStatus(owner(organization.id), { organizationId: organization.id, userId: user.id, status: "suspended" });
    await expect(store.resolveActiveMembership(organization.id, user.id)).resolves.toBeUndefined();
    await expect(store.authenticateBrowserSession(first.token)).resolves.toBeUndefined();
    await expect(store.authenticateBrowserSession(secondOrganizationSession.token)).resolves.toBeDefined();

    await store.updateMembershipStatus(owner(organization.id), { organizationId: organization.id, userId: user.id, status: "active" });
    await expect(store.authenticateBrowserSession(first.token)).resolves.toBeUndefined();
    const second = await store.createBrowserSession({ organizationId: organization.id, userId: user.id, expiresAt: EXPIRES_AT });

    await store.updateMembershipStatus(owner(organization.id), { organizationId: organization.id, userId: user.id, status: "removed" });
    await expect(store.resolveActiveMembership(organization.id, user.id)).resolves.toBeUndefined();
    await expect(store.authenticateBrowserSession(second.token)).resolves.toBeUndefined();
  });

  it("keeps session operations tenant-bound and supports user, organization, and global revocation", async () => {
    const store = memoryStore();
    const alpha = await store.createOrganization({ slug: "alpha", displayName: "Alpha" });
    const beta = await store.createOrganization({ slug: "beta", displayName: "Beta" });
    const firstUser = await store.createUser({ displayName: "First" });
    const secondUser = await store.createUser({ displayName: "Second" });
    await store.grantBootstrapMembership({ organizationId: alpha.id, userId: firstUser.id });
    await store.grantBootstrapMembership({ organizationId: alpha.id, userId: secondUser.id });
    await store.grantBootstrapMembership({ organizationId: beta.id, userId: secondUser.id });

    const firstAlpha = await store.createBrowserSession({ organizationId: alpha.id, userId: firstUser.id, expiresAt: EXPIRES_AT });
    const secondAlpha = await store.createBrowserSession({ organizationId: alpha.id, userId: secondUser.id, expiresAt: EXPIRES_AT });
    const secondBeta = await store.createBrowserSession({ organizationId: beta.id, userId: secondUser.id, expiresAt: EXPIRES_AT });

    await expect(store.resolveActiveMembership(beta.id, firstUser.id)).resolves.toBeUndefined();
    await expect(store.createBrowserSession({ organizationId: beta.id, userId: firstUser.id, expiresAt: EXPIRES_AT }))
      .rejects.toMatchObject({ code: "active_membership_required", organizationId: beta.id, userId: firstUser.id });
    await expect(store.revokeBrowserSession(owner(beta.id), firstAlpha.session.id)).resolves.toBe(false);
    await expect(store.authenticateBrowserSession(firstAlpha.token)).resolves.toBeDefined();

    await expect(store.revokeUserSessions(firstUser.id)).resolves.toBe(1);
    await expect(store.authenticateBrowserSession(firstAlpha.token)).resolves.toBeUndefined();
    await expect(store.authenticateBrowserSession(secondAlpha.token)).resolves.toBeDefined();
    await expect(store.revokeOrganizationSessions(alpha.id)).resolves.toBe(1);
    await expect(store.authenticateBrowserSession(secondAlpha.token)).resolves.toBeUndefined();
    await expect(store.authenticateBrowserSession(secondBeta.token)).resolves.toBeDefined();

    const replacement = await store.createBrowserSession({ organizationId: beta.id, userId: secondUser.id, expiresAt: EXPIRES_AT });
    await expect(store.revokeAllSessions()).resolves.toBe(2);
    await expect(store.authenticateBrowserSession(secondBeta.token)).resolves.toBeUndefined();
    await expect(store.authenticateBrowserSession(replacement.token)).resolves.toBeUndefined();
  });

  it("does not allow identities or verified domains to move between security principals", async () => {
    const store = memoryStore();
    const alpha = await store.createOrganization({ slug: "one", displayName: "One" });
    const beta = await store.createOrganization({ slug: "two", displayName: "Two" });
    const first = await store.createUser({});
    const second = await store.createUser({});
    await store.linkIdentity({ userId: first.id, provider: "google", subject: "shared-subject", emailVerified: false });
    await store.verifyDomain({ organizationId: alpha.id, domain: "shared.example" });

    await expect(store.linkIdentity({
      userId: second.id,
      provider: "google",
      subject: "shared-subject",
      emailVerified: false,
    })).rejects.toBeInstanceOf(IdentityAlreadyLinkedError);
    await expect(store.verifyDomain({ organizationId: beta.id, domain: "shared.example" }))
      .rejects.toBeInstanceOf(VerifiedDomainConflictError);
  });

  it("normalizes password identities and rejects duplicates without creating partial users or memberships", async () => {
    const store = memoryStore();
    const organization = await store.createOrganization({ slug: "passwords", displayName: "Passwords" });
    const registered = await store.registerPasswordUser({
      organizationId: organization.id,
      email: "  Member@Example.Invalid ",
      passwordHash: "synthetic-password-hash-one-long-value",
      displayName: "Synthetic Member",
    });

    expect(registered).toMatchObject({
      user: { displayName: "Synthetic Member" },
      identity: {
        userId: registered.user.id,
        provider: "password",
        subject: "member@example.invalid",
        email: "member@example.invalid",
        emailVerified: false,
      },
      credential: { userId: registered.user.id, passwordHash: "synthetic-password-hash-one-long-value" },
      membership: { organizationId: organization.id, userId: registered.user.id, status: "active" },
    });
    await expect(store.resolvePasswordCredential("MEMBER@EXAMPLE.INVALID")).resolves.toMatchObject({
      user: { id: registered.user.id },
      credential: { passwordHash: "synthetic-password-hash-one-long-value" },
    });

    await expect(store.registerPasswordUser({
      organizationId: organization.id,
      email: "member@example.invalid",
      passwordHash: "synthetic-password-hash-two-long-value",
    })).rejects.toBeInstanceOf(PasswordIdentityAlreadyExistsError);
    await expect(store.listMemberships(organization.id, 200)).resolves.toHaveLength(1);
    await expect(store.resolvePasswordCredential("member@example.invalid")).resolves.toMatchObject({
      credential: { passwordHash: "synthetic-password-hash-one-long-value" },
    });
  });

  it("atomically accepts one exact verified-email invitation and exposes only tenant-scoped membership views", async () => {
    const store = memoryStore();
    const alpha = await store.createOrganization({ slug: "alpha-invites", displayName: "Alpha" });
    const beta = await store.createOrganization({ slug: "beta-invites", displayName: "Beta" });
    const user = await store.createUser({ displayName: "Invited User" });
    await store.linkIdentity({
      userId: user.id,
      provider: "google",
      subject: "invited-google-user",
      email: "INVITED@EXAMPLE.COM",
      emailVerified: true,
    });
    const invitation = await store.createInvitation({
      organizationId: alpha.id,
      email: "Invited@Example.com",
      expiresAt: EXPIRES_AT,
      invitedBy: "admin-user",
    });
    const duplicate = await store.createInvitation({
      organizationId: alpha.id,
      email: "INVITED@example.com",
      expiresAt: "2026-08-26T10:00:00.000Z",
      invitedBy: "another-admin",
    });

    expect(duplicate.id).toBe(invitation.id);
    await expect(store.listInvitations(alpha.id)).resolves.toEqual([
      expect.objectContaining({ id: invitation.id, email: "invited@example.com", status: "pending" }),
    ]);
    const accepted = await store.acceptUniqueInvitation({
      userId: user.id,
      verifiedEmail: "invited@example.com",
    });

    expect(accepted).toMatchObject({
      invitation: { id: invitation.id, organizationId: alpha.id, status: "accepted", acceptedByUserId: user.id },
      membership: { organizationId: alpha.id, userId: user.id, status: "active" },
    });
    await expect(store.listMemberships(alpha.id)).resolves.toEqual([
      expect.objectContaining({
        organizationId: alpha.id,
        userId: user.id,
        status: "active",
        displayName: "Invited User",
        verifiedEmail: "invited@example.com",
      }),
    ]);
    await expect(store.listMemberships(beta.id)).resolves.toEqual([]);
    await expect(store.acceptUniqueInvitation({ userId: user.id, verifiedEmail: "invited@example.com" }))
      .rejects.toMatchObject({ code: "organization_invitation_membership_conflict" });
  });

  it("fails closed for ambiguous, expired, revoked, mismatched, or unverified invitations", async () => {
    let currentTime = new Date(NOW);
    const store = new InMemoryOrganizationStore({ now: () => new Date(currentTime) });
    const alpha = await store.createOrganization({ slug: "alpha-guard", displayName: "Alpha" });
    const beta = await store.createOrganization({ slug: "beta-guard", displayName: "Beta" });
    const user = await store.createUser({ displayName: "Guarded User" });
    await store.linkIdentity({
      userId: user.id,
      provider: "google",
      subject: "guarded-google-user",
      email: "guarded@example.com",
      emailVerified: true,
    });
    const alphaInvitation = await store.createInvitation({
      organizationId: alpha.id,
      email: "guarded@example.com",
      expiresAt: EXPIRES_AT,
      invitedBy: "admin-alpha",
    });
    const betaInvitation = await store.createInvitation({
      organizationId: beta.id,
      email: "guarded@example.com",
      expiresAt: EXPIRES_AT,
      invitedBy: "admin-beta",
    });

    await expect(store.acceptUniqueInvitation({ userId: user.id, verifiedEmail: "guarded@example.com" }))
      .rejects.toMatchObject({ code: "organization_invitation_ambiguous" });
    await expect(store.revokeInvitation({
      organizationId: alpha.id,
      invitationId: betaInvitation.id,
      revokedBy: "admin-alpha",
    })).resolves.toBe(false);
    await expect(store.revokeInvitation({
      organizationId: beta.id,
      invitationId: betaInvitation.id,
      revokedBy: "admin-beta",
    })).resolves.toBe(true);
    await expect(store.acceptUniqueInvitation({
      userId: user.id,
      verifiedEmail: "different@example.com",
      organizationId: alpha.id,
    })).rejects.toMatchObject({ code: "organization_invitation_identity_mismatch" });

    const expiredUser = await store.createUser({});
    await store.linkIdentity({
      userId: expiredUser.id,
      provider: "google",
      subject: "expired-google-user",
      email: "expired@example.com",
      emailVerified: true,
    });
    await store.createInvitation({
      organizationId: alpha.id,
      email: "expired@example.com",
      expiresAt: "2026-08-26T08:30:00.000Z",
      invitedBy: "admin-alpha",
    });
    currentTime = new Date("2026-08-26T08:31:00.000Z");
    await expect(store.acceptUniqueInvitation({ userId: expiredUser.id, verifiedEmail: "expired@example.com" }))
      .rejects.toMatchObject({ code: "organization_invitation_required" });

    const unverifiedUser = await store.createUser({});
    await store.linkIdentity({
      userId: unverifiedUser.id,
      provider: "google",
      subject: "unverified-google-user",
      email: "unverified@example.com",
      emailVerified: false,
    });
    await store.createInvitation({
      organizationId: alpha.id,
      email: "unverified@example.com",
      expiresAt: EXPIRES_AT,
      invitedBy: "admin-alpha",
    });
    await expect(store.acceptUniqueInvitation({ userId: unverifiedUser.id, verifiedEmail: "unverified@example.com" }))
      .rejects.toBeInstanceOf(OrganizationInvitationResolutionError);
    await expect(store.listInvitations(alpha.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: alphaInvitation.id, status: "pending" }),
      expect.objectContaining({ email: "expired@example.com", status: "expired" }),
    ]));
  });
});

describe("PrismaOrganizationStore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("idempotently seeds an explicitly named single-tenant organization", async () => {
    const findUnique = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "tenant-explicit",
        slug: "tenant-explicit",
        displayName: "Explicit tenant",
        createdAt: NOW,
        updatedAt: NOW,
      });
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const database = {
      $connect: vi.fn(async () => undefined),
      platformOrganization: { findUnique, create },
    } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.ensureOrganization({
      id: "tenant-explicit",
      slug: "tenant-explicit",
      displayName: "Explicit tenant",
    })).resolves.toMatchObject({ id: "tenant-explicit" });
    await expect(store.ensureOrganization({
      id: "tenant-explicit",
      slug: "tenant-explicit",
      displayName: "Explicit tenant",
    })).resolves.toMatchObject({ id: "tenant-explicit" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ id: "tenant-explicit" }) });
  });

  it("creates a provider identity and its internal user atomically", async () => {
    const user = {
      id: "22222222-2222-4222-8222-222222222222",
      displayName: "QA User",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const identity = {
      userId: user.id,
      provider: "google",
      providerSubject: "google-user-1",
      email: "qa@example.com",
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const transactionClient = {
      platformUserIdentity: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => identity),
      },
      platformUser: { create: vi.fn(async () => user) },
    };
    const transaction = vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) => operation(transactionClient));
    const database = { $connect: vi.fn(async () => undefined), $transaction: transaction } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.resolveOrCreateIdentity({
      provider: "google",
      subject: "google-user-1",
      email: "QA@EXAMPLE.COM",
      emailVerified: true,
      displayName: "QA User",
    })).resolves.toEqual({
      user: expect.objectContaining({ id: user.id }),
      identity: expect.objectContaining({ userId: user.id, subject: "google-user-1", email: "qa@example.com" }),
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(transactionClient.platformUserIdentity.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: user.id,
      provider: "google",
      providerSubject: "google-user-1",
      email: "qa@example.com",
    }) });
  });

  it("creates a normalized password identity, credential, and active membership in one transaction", async () => {
    const membership = membershipRow("active");
    const user = {
      id: membership.userId,
      displayName: "Synthetic Member",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const identity = {
      userId: user.id,
      provider: "password",
      providerSubject: "member@example.invalid",
      email: "member@example.invalid",
      emailVerified: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const credential = {
      userId: user.id,
      passwordHash: "synthetic-password-hash-long-enough",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const transactionClient = {
      platformOrganization: { findUnique: vi.fn(async () => ({ id: membership.organizationId })) },
      platformUserIdentity: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => identity),
      },
      platformUser: { create: vi.fn(async () => user) },
      platformPasswordCredential: { create: vi.fn(async () => credential) },
      platformOrganizationMembership: { create: vi.fn(async () => membership) },
    };
    const transaction = vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) => (
      operation(transactionClient)
    ));
    const database = { $connect: vi.fn(async () => undefined), $transaction: transaction } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.registerPasswordUser({
      organizationId: membership.organizationId,
      email: " Member@Example.Invalid ",
      passwordHash: credential.passwordHash,
      displayName: user.displayName,
    })).resolves.toMatchObject({
      user: { id: user.id },
      identity: { subject: identity.providerSubject, email: identity.email, emailVerified: false },
      credential: { passwordHash: credential.passwordHash },
      membership: { status: "active" },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(transactionClient.platformOrganization.findUnique).toHaveBeenCalledWith({
      where: { id: membership.organizationId },
      select: { id: true },
    });
    expect(transactionClient.platformUserIdentity.findUnique).toHaveBeenCalledWith({
      where: {
        provider_providerSubject: { provider: "password", providerSubject: "member@example.invalid" },
      },
      select: { userId: true },
    });
    expect(transactionClient.platformUserIdentity.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: user.id,
      provider: "password",
      providerSubject: "member@example.invalid",
      email: "member@example.invalid",
      emailVerified: false,
    }) });
    expect(transactionClient.platformPasswordCredential.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: user.id,
      passwordHash: credential.passwordHash,
    }) });
    expect(transactionClient.platformOrganizationMembership.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      organizationId: membership.organizationId,
      userId: user.id,
      status: "active",
    }) });
  });

  it("requires initialization and asks Prisma only for an explicitly active tenant membership", async () => {
    const findFirst = vi.fn(async () => undefined);
    const database = {
      $connect: vi.fn(async () => undefined),
      platformOrganizationMembership: { findFirst },
    } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });

    await expect(store.resolveActiveMembership("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"))
      .rejects.toThrow("has not been initialized");
    await store.init();
    await expect(store.resolveActiveMembership("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"))
      .resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({ where: {
      organizationId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      status: "active",
    } });
  });

  it("lists organization-selection candidates through an active user membership join", async () => {
    const membership = membershipRow("active");
    const organization = {
      id: membership.organizationId,
      slug: "scoped-organization",
      displayName: "Scoped Organization",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const findMany = vi.fn(async () => [{ ...membership, organization }]);
    const database = {
      $connect: vi.fn(async () => undefined),
      platformOrganizationMembership: { findMany },
    } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.listActiveOrganizationsForUser(membership.userId)).resolves.toEqual([
      expect.objectContaining({ id: membership.organizationId, displayName: "Scoped Organization" }),
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: membership.userId, status: "active" },
      orderBy: [
        { organization: { displayName: "asc" } },
        { organizationId: "asc" },
      ],
      include: { organization: true },
    });
  });

  it("creates only hash-backed sessions inside an active-membership transaction", async () => {
    const membership = membershipRow("active");
    const findFirst = vi.fn(async () => membership);
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      createdAt: NOW,
      expiresAt: new Date(EXPIRES_AT),
      lastSeenAt: null,
      revokedAt: null,
    }));
    const transactionClient = {
      platformOrganizationMembership: { findFirst },
      platformBrowserSession: { create },
    };
    const transaction = vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) => operation(transactionClient));
    const database = { $connect: vi.fn(async () => undefined), $transaction: transaction } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    const created = await store.createBrowserSession({
      organizationId: membership.organizationId,
      userId: membership.userId,
      expiresAt: EXPIRES_AT,
    });

    expect(findFirst).toHaveBeenCalledWith({ where: {
      organizationId: membership.organizationId,
      userId: membership.userId,
      status: "active",
    } });
    const persisted = create.mock.calls[0]?.[0].data;
    expect(persisted).toEqual(expect.objectContaining({
      id: created.session.id,
      organizationId: membership.organizationId,
      userId: membership.userId,
      tokenHash: expect.any(Uint8Array),
    }));
    expect(persisted).not.toHaveProperty("token");
    expect(created.session).not.toHaveProperty("tokenHash");
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("rejects inactive membership before persisting a Prisma session", async () => {
    const create = vi.fn();
    const transactionClient = {
      platformOrganizationMembership: { findFirst: vi.fn(async () => undefined) },
      platformBrowserSession: { create },
    };
    const database = {
      $connect: vi.fn(async () => undefined),
      $transaction: vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) => operation(transactionClient)),
    } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.createBrowserSession({
      organizationId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      expiresAt: EXPIRES_AT,
    })).rejects.toBeInstanceOf(ActiveMembershipRequiredError);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a hash-valid Prisma session after its membership is no longer active", async () => {
    const membership = membershipRow("active");
    const user = {
      id: membership.userId,
      displayName: "Member",
      createdAt: NOW,
      updatedAt: NOW,
    };
    let persisted: Record<string, unknown> | undefined;
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn(async () => ({
      ...persisted,
      membership: { ...membership, status: "suspended", user },
    }));
    const transactionClient = {
      platformOrganizationMembership: { findFirst: vi.fn(async () => membership) },
      platformBrowserSession: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          persisted = {
            ...data,
            createdAt: NOW,
            expiresAt: new Date(EXPIRES_AT),
            lastSeenAt: null,
            revokedAt: null,
          };
          return persisted;
        }),
        findUnique,
        updateMany,
      },
    };
    const database = {
      $connect: vi.fn(async () => undefined),
      $transaction: vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) => operation(transactionClient)),
    } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();
    const created = await store.createBrowserSession({
      organizationId: membership.organizationId,
      userId: membership.userId,
      expiresAt: EXPIRES_AT,
    });

    await expect(store.authenticateBrowserSession(created.token)).resolves.toBeUndefined();
    expect(findUnique).toHaveBeenCalledOnce();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("touches concurrent valid Prisma sessions at read-committed isolation", async () => {
    const membership = membershipRow("active");
    const user = {
      id: membership.userId,
      displayName: "Member",
      createdAt: NOW,
      updatedAt: NOW,
    };
    let persisted: Record<string, unknown> | undefined;
    const findUnique = vi.fn(async () => ({ ...persisted, membership: { ...membership, user } }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const transactionClient = {
      platformOrganizationMembership: { findFirst: vi.fn(async () => membership) },
      platformBrowserSession: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          persisted = {
            ...data,
            createdAt: NOW,
            expiresAt: new Date(EXPIRES_AT),
            lastSeenAt: null,
            revokedAt: null,
          };
          return persisted;
        }),
        findUnique,
        updateMany,
      },
    };
    const transaction = vi.fn(async (
      operation: (client: typeof transactionClient) => Promise<unknown>,
      _options?: { isolationLevel: string },
    ) => operation(transactionClient));
    const database = {
      $connect: vi.fn(async () => undefined),
      $transaction: transaction,
    } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();
    const created = await store.createBrowserSession({
      organizationId: membership.organizationId,
      userId: membership.userId,
      expiresAt: EXPIRES_AT,
    });
    transaction.mockClear();

    await expect(Promise.all([
      store.authenticateBrowserSession(created.token),
      store.authenticateBrowserSession(created.token),
      store.authenticateBrowserSession(created.token),
    ])).resolves.toEqual([
      expect.objectContaining({ session: expect.objectContaining({ id: created.session.id }) }),
      expect.objectContaining({ session: expect.objectContaining({ id: created.session.id }) }),
      expect.objectContaining({ session: expect.objectContaining({ id: created.session.id }) }),
    ]);
    expect(transaction).toHaveBeenCalledTimes(3);
    for (const [, options] of transaction.mock.calls) {
      expect(options).toEqual({ isolationLevel: "ReadCommitted" });
    }
    expect(findUnique).toHaveBeenCalledTimes(3);
    expect(updateMany).toHaveBeenCalledTimes(3);
  });

  it("rejects a session when a concurrent revoke wins before the authentication touch", async () => {
    const membership = membershipRow("active");
    const user = {
      id: membership.userId,
      displayName: "Member",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const persisted = {
      id: "11111111-1111-4111-8111-111111111111",
      organizationId: membership.organizationId,
      userId: membership.userId,
      tokenHash: new Uint8Array(32),
      createdAt: new Date(NOW),
      expiresAt: new Date(EXPIRES_AT),
      lastSeenAt: null,
      revokedAt: null,
      membership: { ...membership, user },
    };
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const transactionClient = {
      platformBrowserSession: {
        findUnique: vi.fn(async () => persisted),
        updateMany,
      },
    };
    const database = {
      $connect: vi.fn(async () => undefined),
      $transaction: vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) => operation(transactionClient)),
    } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    const token = `qsy_session_${persisted.id}_${"A".repeat(43)}`;
    persisted.tokenHash = Uint8Array.from(createHash("sha256").update(token).digest());

    await expect(store.authenticateBrowserSession(token)).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: persisted.id,
        organizationId: persisted.organizationId,
        userId: persisted.userId,
        revokedAt: null,
        expiresAt: { gt: new Date(NOW) },
      },
      data: { lastSeenAt: new Date(NOW) },
    });
  });

  it("revokes only the membership's sessions in the same Prisma transaction when access is suspended", async () => {
    const membership = membershipRow("suspended");
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const transactionClient = {
      platformOrganizationMembership: {
        findUnique: vi.fn(async () => ({ organizationId: membership.organizationId, userId: membership.userId })),
        update: vi.fn(async () => membership),
      },
      platformBrowserSession: { updateMany },
    };
    const transaction = vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) => operation(transactionClient));
    const database = { $connect: vi.fn(async () => undefined), $transaction: transaction } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.updateMembershipStatus(owner(membership.organizationId), {
      organizationId: membership.organizationId,
      userId: membership.userId,
      status: "suspended",
    })).resolves.toMatchObject({ status: "suspended" });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: membership.organizationId,
        userId: membership.userId,
        revokedAt: null,
      },
      data: { revokedAt: NOW },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("retries the complete membership revocation transaction after a Prisma serialization failure", async () => {
    const membership = membershipRow("suspended");
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const transactionClient = {
      platformOrganizationMembership: {
        findUnique: vi.fn(async () => ({ organizationId: membership.organizationId, userId: membership.userId })),
        update: vi.fn(async () => membership),
      },
      platformBrowserSession: { updateMany },
    };
    let attempt = 0;
    const transaction = vi.fn(async (
      operation: (client: typeof transactionClient) => Promise<unknown>,
      _options?: { isolationLevel: string },
    ) => {
      attempt += 1;
      if (attempt === 1) throw { code: "P2034" };
      return operation(transactionClient);
    });
    const database = { $connect: vi.fn(async () => undefined), $transaction: transaction } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.updateMembershipStatus(owner(membership.organizationId), {
      organizationId: membership.organizationId,
      userId: membership.userId,
      status: "suspended",
    })).resolves.toMatchObject({ status: "suspended" });
    expect(transaction).toHaveBeenCalledTimes(2);
    for (const [, options] of transaction.mock.calls) {
      expect(options).toEqual({ isolationLevel: "Serializable" });
    }
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it("keeps a single-session revocation scoped to the owning organization", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const database = {
      $connect: vi.fn(async () => undefined),
      platformBrowserSession: { updateMany },
    } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.revokeBrowserSession(owner("11111111-1111-4111-8111-111111111111"), "33333333-3333-4333-8333-333333333333"))
      .resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "33333333-3333-4333-8333-333333333333",
        organizationId: "11111111-1111-4111-8111-111111111111",
        revokedAt: null,
      },
      data: { revokedAt: NOW },
    });
  });

  it("accepts a unique invitation and creates membership in one serializable transaction", async () => {
    const invitation = invitationRow();
    const acceptedInvitation = { ...invitation, acceptedAt: NOW, acceptedByUserId: invitation.userId };
    const membership = membershipRow("active");
    const transactionClient = {
      platformUserIdentity: { findFirst: vi.fn(async () => ({ userId: membership.userId })) },
      platformOrganizationInvitation: {
        findMany: vi.fn(async () => [invitation]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => acceptedInvitation),
      },
      platformOrganizationMembership: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => membership),
      },
    };
    const transaction = vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) => operation(transactionClient));
    const database = { $connect: vi.fn(async () => undefined), $transaction: transaction } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.acceptUniqueInvitation({
      userId: membership.userId,
      verifiedEmail: invitation.email,
      organizationId: membership.organizationId,
    })).resolves.toMatchObject({
      invitation: { id: invitation.id, status: "accepted" },
      membership: { status: "active" },
    });
    expect(transactionClient.platformOrganizationInvitation.findMany).toHaveBeenCalledWith({
      where: {
        email: invitation.email,
        organizationId: membership.organizationId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: NOW },
      },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("recovers a concurrent duplicate create by returning the winning pending invitation", async () => {
    const invitation = invitationRow();
    const findMany = vi.fn(async () => [invitation]);
    const database = {
      $connect: vi.fn(async () => undefined),
      $transaction: vi.fn(async () => { throw { code: "P2002" }; }),
      platformOrganizationInvitation: { findMany },
    } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.createInvitation({
      organizationId: invitation.organizationId,
      email: "INVITED@EXAMPLE.COM",
      expiresAt: EXPIRES_AT,
      invitedBy: "admin-user",
    })).resolves.toMatchObject({ id: invitation.id, status: "pending" });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: invitation.organizationId,
        email: invitation.email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: NOW },
      },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
  });

  it("lists membership identity metadata through an organization-scoped Prisma query", async () => {
    const membership = membershipRow("active");
    const findMany = vi.fn(async () => [{
      ...membership,
      user: {
        id: membership.userId,
        displayName: "Scoped Member",
        createdAt: NOW,
        updatedAt: NOW,
        identities: [{
          userId: membership.userId,
          provider: "google",
          providerSubject: "scoped-google-user",
          email: "scoped@example.com",
          emailVerified: true,
          createdAt: NOW,
          updatedAt: NOW,
        }],
      },
    }]);
    const database = {
      $connect: vi.fn(async () => undefined),
      platformOrganization: { findUnique: vi.fn(async () => ({ id: membership.organizationId })) },
      platformOrganizationMembership: { findMany },
    } as unknown as PrismaClient;
    const store = new PrismaOrganizationStore(database, { now: () => new Date(NOW) });
    await store.init();

    await expect(store.listMemberships(membership.organizationId, 25)).resolves.toEqual([
      expect.objectContaining({
        organizationId: membership.organizationId,
        userId: membership.userId,
        displayName: "Scoped Member",
        verifiedEmail: "scoped@example.com",
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: membership.organizationId },
      take: 25,
    }));
  });
});

describe("organization persistence migration", () => {
  it("models explicit membership, globally unique verified domains, and hash-only browser sessions", async () => {
    const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    const migration = await readFile(new URL(
      "../../prisma/migrations/20260826152000_add_organization_identity_sessions/migration.sql",
      import.meta.url,
    ), "utf8");
    const sessionModel = /model PlatformBrowserSession \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? "";

    for (const model of [
      "PlatformOrganization",
      "PlatformUser",
      "PlatformUserIdentity",
      "PlatformOrganizationMembership",
      "PlatformOrganizationDomain",
      "PlatformBrowserSession",
    ]) expect(schema).toContain(`model ${model} {`);
    expect(sessionModel).toMatch(/tokenHash\s+Bytes\s+@unique\s+@map\("token_hash"\)/u);
    expect(sessionModel).not.toMatch(/^\s*token\s+/mu);
    expect(migration).toMatch(/CHECK \("status" IN \('active', 'suspended', 'removed'\)\)/u);
    expect(migration).toMatch(/CREATE TABLE "platform_organizations" \([\s\S]*?"id" TEXT NOT NULL/u);
    expect(migration).toMatch(/"token_hash" BYTEA NOT NULL UNIQUE/u);
    expect(migration).not.toMatch(/"token"\s+(?:TEXT|BYTEA)/u);
    expect(migration).toContain("FOREIGN KEY (\"organization_id\", \"user_id\")");
  });
});

function memoryStore(): InMemoryOrganizationStore {
  return new InMemoryOrganizationStore({ now: () => new Date(NOW) });
}

function owner(tenantId: string) {
  return { applicationId: "platform", tenantId };
}

function membershipRow(status: "active" | "suspended" | "removed") {
  return {
    organizationId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function invitationRow() {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    email: "invited@example.com",
    expiresAt: new Date(EXPIRES_AT),
    invitedBy: "admin-user",
    acceptedAt: null,
    acceptedByUserId: null,
    revokedAt: null,
    revokedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
