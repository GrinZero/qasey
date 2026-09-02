import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  PlatformBrowserSession as PrismaBrowserSession,
  PlatformOrganization as PrismaOrganization,
  PlatformOrganizationDomain as PrismaOrganizationDomain,
  PlatformOrganizationInvitation as PrismaOrganizationInvitation,
  PlatformOrganizationMembership as PrismaOrganizationMembership,
  PlatformPasswordCredential as PrismaPasswordCredential,
  PlatformUser as PrismaUser,
  PlatformUserIdentity as PrismaUserIdentity,
  PrismaClient,
} from "@prisma/client";
import { OwnerScopeSchema, type OwnerScope } from "../../../packages/contracts/src/index.ts";

const SESSION_TOKEN_PATTERN = /^qsy_session_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/u;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/u;
const SYSTEM_EXPIRED_INVITATION_REVOKER = "system:expired-invitation-replaced";

export type MembershipStatus = "active" | "suspended" | "removed";
export type OrganizationInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface OrganizationRecord {
  /** Organization IDs are the trusted tenant IDs used by the rest of the platform. */
  id: string;
  slug: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserRecord {
  id: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserIdentityRecord {
  userId: string;
  provider: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PasswordCredentialRecord {
  userId: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisteredPasswordUser {
  user: UserRecord;
  identity: UserIdentityRecord;
  credential: PasswordCredentialRecord;
  membership: MembershipRecord;
}

export interface MembershipRecord {
  organizationId: string;
  userId: string;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMembershipView extends MembershipRecord {
  displayName?: string;
  verifiedEmail?: string;
}

export interface OrganizationInvitationRecord {
  id: string;
  organizationId: string;
  email: string;
  status: OrganizationInvitationStatus;
  expiresAt: string;
  invitedBy: string;
  acceptedAt?: string;
  acceptedByUserId?: string;
  revokedAt?: string;
  revokedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AcceptedOrganizationInvitation {
  invitation: OrganizationInvitationRecord;
  membership: MembershipRecord;
}

export interface VerifiedDomainRecord {
  organizationId: string;
  domain: string;
  verifiedAt: string;
  createdAt: string;
}

export interface BrowserSessionRecord {
  id: string;
  organizationId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export interface CreatedBrowserSession {
  /** The plaintext bearer token is returned once and is never persisted. */
  token: string;
  session: BrowserSessionRecord;
}

export interface AuthenticatedBrowserSession {
  session: BrowserSessionRecord;
  membership: MembershipRecord;
  user: UserRecord;
}

export interface OrganizationStoreOptions {
  now?: () => Date;
}

export interface ResolveOrCreateIdentityInput {
  provider: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
}

export interface OrganizationStore {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  createOrganization(input: { id?: string; slug: string; displayName: string }): Promise<OrganizationRecord>;
  ensureOrganization(input: { id: string; slug: string; displayName: string }): Promise<OrganizationRecord>;
  createUser(input: { displayName?: string }): Promise<UserRecord>;
  linkIdentity(input: {
    userId: string;
    provider: string;
    subject: string;
    email?: string;
    emailVerified: boolean;
  }): Promise<UserIdentityRecord>;
  resolveIdentity(provider: string, subject: string): Promise<{ user: UserRecord; identity: UserIdentityRecord } | undefined>;
  resolveIdentityForUser(userId: string, provider: string): Promise<UserIdentityRecord | undefined>;
  resolveOrCreateIdentity(input: ResolveOrCreateIdentityInput): Promise<{ user: UserRecord; identity: UserIdentityRecord }>;
  registerPasswordUser(input: {
    organizationId: string;
    email: string;
    passwordHash: string;
    displayName?: string;
  }): Promise<RegisteredPasswordUser>;
  resolvePasswordCredential(email: string): Promise<{
    user: UserRecord;
    identity: UserIdentityRecord;
    credential: PasswordCredentialRecord;
  } | undefined>;
  updateMembershipStatus(scope: OwnerScope, input: {
    organizationId: string;
    userId: string;
    status: MembershipStatus;
  }): Promise<MembershipRecord>;
  /** Trusted OIDC bootstrap path. It can only create or restore an active membership. */
  grantBootstrapMembership(input: { organizationId: string; userId: string }): Promise<MembershipRecord>;
  resolveMembership(organizationId: string, userId: string): Promise<MembershipRecord | undefined>;
  resolveActiveMembership(organizationId: string, userId: string): Promise<MembershipRecord | undefined>;
  listActiveMembershipsForUser(userId: string): Promise<readonly MembershipRecord[]>;
  /** Returns only organizations for which the user currently has an explicit active membership. */
  listActiveOrganizationsForUser(userId: string): Promise<readonly OrganizationRecord[]>;
  listMemberships(organizationId: string, limit?: number): Promise<readonly OrganizationMembershipView[]>;
  createInvitation(input: {
    organizationId: string;
    email: string;
    expiresAt: string;
    invitedBy: string;
  }): Promise<OrganizationInvitationRecord>;
  listInvitations(organizationId: string, limit?: number): Promise<readonly OrganizationInvitationRecord[]>;
  revokeInvitation(input: {
    organizationId: string;
    invitationId: string;
    revokedBy: string;
  }): Promise<boolean>;
  /** Finds and consumes exactly one currently valid invitation in the same atomic operation. */
  acceptUniqueInvitation(input: {
    userId: string;
    verifiedEmail: string;
    organizationId?: string;
  }): Promise<AcceptedOrganizationInvitation>;
  verifyDomain(input: { organizationId: string; domain: string; verifiedAt?: string }): Promise<VerifiedDomainRecord>;
  /** Discovery is informational. It never creates, changes, or implies membership. */
  discoverOrganizationsForIdentity(provider: string, subject: string): Promise<readonly OrganizationRecord[]>;
  createBrowserSession(input: { organizationId: string; userId: string; expiresAt: string }): Promise<CreatedBrowserSession>;
  authenticateBrowserSession(token: string): Promise<AuthenticatedBrowserSession | undefined>;
  revokeBrowserSession(scope: OwnerScope, sessionId: string): Promise<boolean>;
  revokeUserSessions(userId: string): Promise<number>;
  revokeOrganizationSessions(organizationId: string): Promise<number>;
  revokeAllSessions(): Promise<number>;
  close?(): Promise<void>;
}

export class ActiveMembershipRequiredError extends Error {
  readonly code = "active_membership_required";

  constructor(readonly organizationId: string, readonly userId: string) {
    super(`An explicit active membership is required for user ${userId} in organization ${organizationId}`);
    this.name = "ActiveMembershipRequiredError";
  }
}

export class IdentityAlreadyLinkedError extends Error {
  readonly code = "identity_already_linked";

  constructor(readonly provider: string, readonly subject: string) {
    super(`Identity ${provider}:${subject} is already linked to another user`);
    this.name = "IdentityAlreadyLinkedError";
  }
}

export class PasswordIdentityAlreadyExistsError extends Error {
  readonly code = "password_identity_already_exists";

  constructor() {
    super("A password identity already exists for this email address");
    this.name = "PasswordIdentityAlreadyExistsError";
  }
}

export class VerifiedDomainConflictError extends Error {
  readonly code = "verified_domain_conflict";

  constructor(readonly domain: string) {
    super(`Verified domain ${domain} is already owned by another organization`);
    this.name = "VerifiedDomainConflictError";
  }
}

export class OrganizationStoreNotFoundError extends Error {
  readonly code = "organization_store_record_not_found";

  constructor(readonly entity: "organization" | "user", readonly id: string) {
    super(`${entity} ${id} does not exist`);
    this.name = "OrganizationStoreNotFoundError";
  }
}

export class OrganizationStoreConflictError extends Error {
  readonly code = "organization_store_conflict";

  constructor(readonly field: "id" | "slug", readonly value: string) {
    super(`An organization with ${field} ${value} already exists`);
    this.name = "OrganizationStoreConflictError";
  }
}

export class OrganizationScopeMismatchError extends Error {
  readonly code = "organization_scope_mismatch";

  constructor() {
    super("Organization owner scope does not match the requested organization");
    this.name = "OrganizationScopeMismatchError";
  }
}

export class OrganizationMembershipNotFoundError extends Error {
  readonly code = "organization_membership_not_found";

  constructor() {
    super("Organization membership does not exist");
    this.name = "OrganizationMembershipNotFoundError";
  }
}

export type OrganizationInvitationResolutionCode =
  | "organization_invitation_required"
  | "organization_invitation_ambiguous"
  | "organization_invitation_identity_mismatch"
  | "organization_invitation_membership_conflict"
  | "organization_invitation_concurrent_conflict";

export class OrganizationInvitationResolutionError extends Error {
  constructor(readonly code: OrganizationInvitationResolutionCode) {
    super(code);
    this.name = "OrganizationInvitationResolutionError";
  }
}

export class OrganizationInvitationConflictError extends Error {
  readonly code = "organization_invitation_pending_conflict";

  constructor(readonly organizationId: string, readonly email: string) {
    super(`Multiple pending invitations exist for ${email} in organization ${organizationId}`);
    this.name = "OrganizationInvitationConflictError";
  }
}

interface StoredBrowserSession extends BrowserSessionRecord {
  tokenHash: Buffer;
}

type StoredOrganizationInvitation = Omit<OrganizationInvitationRecord, "status">;

export class InMemoryOrganizationStore implements OrganizationStore {
  private readonly organizations = new Map<string, OrganizationRecord>();
  private readonly organizationSlugs = new Map<string, string>();
  private readonly users = new Map<string, UserRecord>();
  private readonly identities = new Map<string, UserIdentityRecord>();
  private readonly passwordCredentials = new Map<string, PasswordCredentialRecord>();
  private readonly memberships = new Map<string, MembershipRecord>();
  private readonly invitations = new Map<string, StoredOrganizationInvitation>();
  private readonly verifiedDomains = new Map<string, VerifiedDomainRecord>();
  private readonly sessions = new Map<string, StoredBrowserSession>();
  private readonly now: () => Date;

  constructor(options: OrganizationStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async createOrganization(input: { id?: string; slug: string; displayName: string }): Promise<OrganizationRecord> {
    const slug = normalizeSlug(input.slug);
    const displayName = requiredText(input.displayName, "displayName");
    if (this.organizationSlugs.has(slug)) throw new OrganizationStoreConflictError("slug", slug);
    const id = input.id === undefined ? randomUUID() : requiredText(input.id, "id");
    if (this.organizations.has(id)) throw new OrganizationStoreConflictError("id", id);
    const now = this.now().toISOString();
    const organization: OrganizationRecord = { id, slug, displayName, createdAt: now, updatedAt: now };
    this.organizations.set(organization.id, organization);
    this.organizationSlugs.set(slug, organization.id);
    return structuredClone(organization);
  }

  async ensureOrganization(input: { id: string; slug: string; displayName: string }): Promise<OrganizationRecord> {
    const id = requiredText(input.id, "id");
    const existing = this.organizations.get(id);
    if (existing) return structuredClone(existing);
    return this.createOrganization({ ...input, id });
  }

  async createUser(input: { displayName?: string }): Promise<UserRecord> {
    const now = this.now().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      ...(input.displayName === undefined ? {} : { displayName: requiredText(input.displayName, "displayName") }),
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    return structuredClone(user);
  }

  async linkIdentity(input: {
    userId: string;
    provider: string;
    subject: string;
    email?: string;
    emailVerified: boolean;
  }): Promise<UserIdentityRecord> {
    this.requireUser(input.userId);
    const provider = normalizeProvider(input.provider);
    const subject = requiredText(input.subject, "subject");
    const key = identityKey(provider, subject);
    const existing = this.identities.get(key);
    if (existing) {
      if (existing.userId !== input.userId) throw new IdentityAlreadyLinkedError(provider, subject);
      return structuredClone(existing);
    }
    const now = this.now().toISOString();
    const identity: UserIdentityRecord = {
      userId: input.userId,
      provider,
      subject,
      ...(input.email === undefined ? {} : { email: normalizeEmail(input.email) }),
      emailVerified: input.emailVerified,
      createdAt: now,
      updatedAt: now,
    };
    this.identities.set(key, identity);
    return structuredClone(identity);
  }

  async resolveIdentity(providerInput: string, subjectInput: string): Promise<{ user: UserRecord; identity: UserIdentityRecord } | undefined> {
    const provider = normalizeProvider(providerInput);
    const subject = requiredText(subjectInput, "subject");
    const identity = this.identities.get(identityKey(provider, subject));
    const user = identity ? this.users.get(identity.userId) : undefined;
    return identity && user ? { identity: structuredClone(identity), user: structuredClone(user) } : undefined;
  }

  async resolveIdentityForUser(userId: string, providerInput: string): Promise<UserIdentityRecord | undefined> {
    const provider = normalizeProvider(providerInput);
    const identity = [...this.identities.values()].find(candidate => candidate.userId === userId && candidate.provider === provider);
    return identity ? structuredClone(identity) : undefined;
  }

  async resolveOrCreateIdentity(input: ResolveOrCreateIdentityInput): Promise<{ user: UserRecord; identity: UserIdentityRecord }> {
    const provider = normalizeProvider(input.provider);
    const subject = requiredText(input.subject, "subject");
    const key = identityKey(provider, subject);
    const existingIdentity = this.identities.get(key);
    const now = this.now().toISOString();
    if (existingIdentity) {
      const existingUser = this.requireUser(existingIdentity.userId);
      const identity: UserIdentityRecord = {
        ...existingIdentity,
        ...(input.email === undefined ? {} : { email: normalizeEmail(input.email) }),
        emailVerified: input.emailVerified,
        updatedAt: now,
      };
      const user: UserRecord = {
        ...existingUser,
        ...(input.displayName === undefined ? {} : { displayName: requiredText(input.displayName, "displayName") }),
        updatedAt: now,
      };
      this.identities.set(key, identity);
      this.users.set(user.id, user);
      return { identity: structuredClone(identity), user: structuredClone(user) };
    }
    const user: UserRecord = {
      id: randomUUID(),
      ...(input.displayName === undefined ? {} : { displayName: requiredText(input.displayName, "displayName") }),
      createdAt: now,
      updatedAt: now,
    };
    const identity: UserIdentityRecord = {
      userId: user.id,
      provider,
      subject,
      ...(input.email === undefined ? {} : { email: normalizeEmail(input.email) }),
      emailVerified: input.emailVerified,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    this.identities.set(key, identity);
    return { identity: structuredClone(identity), user: structuredClone(user) };
  }

  async registerPasswordUser(input: {
    organizationId: string;
    email: string;
    passwordHash: string;
    displayName?: string;
  }): Promise<RegisteredPasswordUser> {
    this.requireOrganization(input.organizationId);
    const email = normalizeEmail(input.email);
    const identityAddress = identityKey("password", email);
    if (this.identities.has(identityAddress)) throw new PasswordIdentityAlreadyExistsError();
    const now = this.now().toISOString();
    const user: UserRecord = {
      id: randomUUID(),
      ...(input.displayName === undefined ? {} : { displayName: requiredText(input.displayName, "displayName") }),
      createdAt: now,
      updatedAt: now,
    };
    const identity: UserIdentityRecord = {
      userId: user.id,
      provider: "password",
      subject: email,
      email,
      // Owning a password does not prove control of the email inbox. Keeping
      // this false prevents local signup from consuming verified-email invites.
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    };
    const credential: PasswordCredentialRecord = {
      userId: user.id,
      passwordHash: passwordHashText(input.passwordHash),
      createdAt: now,
      updatedAt: now,
    };
    const membership: MembershipRecord = {
      organizationId: input.organizationId,
      userId: user.id,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    this.identities.set(identityAddress, identity);
    this.passwordCredentials.set(user.id, credential);
    this.memberships.set(membershipKey(input.organizationId, user.id), membership);
    return structuredClone({ user, identity, credential, membership });
  }

  async resolvePasswordCredential(emailInput: string): Promise<{
    user: UserRecord;
    identity: UserIdentityRecord;
    credential: PasswordCredentialRecord;
  } | undefined> {
    const identity = this.identities.get(identityKey("password", normalizeEmail(emailInput)));
    const user = identity ? this.users.get(identity.userId) : undefined;
    const credential = identity ? this.passwordCredentials.get(identity.userId) : undefined;
    return identity && user && credential ? structuredClone({ identity, user, credential }) : undefined;
  }

  async updateMembershipStatus(scope: OwnerScope, input: {
    organizationId: string;
    userId: string;
    status: MembershipStatus;
  }): Promise<MembershipRecord> {
    assertOrganizationScope(scope, input.organizationId);
    this.requireOrganization(input.organizationId);
    this.requireUser(input.userId);
    const status = membershipStatus(input.status);
    const key = membershipKey(input.organizationId, input.userId);
    const existing = this.memberships.get(key);
    if (!existing) throw new OrganizationMembershipNotFoundError();
    const now = this.now().toISOString();
    const membership: MembershipRecord = {
      organizationId: input.organizationId,
      userId: input.userId,
      status,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    this.memberships.set(key, membership);
    if (status !== "active") this.revokeMembershipSessionsAt(input.organizationId, input.userId, now);
    return structuredClone(membership);
  }

  async grantBootstrapMembership(input: { organizationId: string; userId: string }): Promise<MembershipRecord> {
    this.requireOrganization(input.organizationId);
    this.requireUser(input.userId);
    const key = membershipKey(input.organizationId, input.userId);
    const existing = this.memberships.get(key);
    const now = this.now().toISOString();
    const membership: MembershipRecord = {
      ...input,
      status: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.memberships.set(key, membership);
    return structuredClone(membership);
  }

  async resolveActiveMembership(organizationId: string, userId: string): Promise<MembershipRecord | undefined> {
    const membership = await this.resolveMembership(organizationId, userId);
    return membership?.status === "active" ? structuredClone(membership) : undefined;
  }

  async resolveMembership(organizationId: string, userId: string): Promise<MembershipRecord | undefined> {
    const membership = this.memberships.get(membershipKey(organizationId, userId));
    return membership ? structuredClone(membership) : undefined;
  }

  async listActiveMembershipsForUser(userId: string): Promise<readonly MembershipRecord[]> {
    return [...this.memberships.values()]
      .filter(membership => membership.userId === userId && membership.status === "active")
      .sort((left, right) => left.organizationId.localeCompare(right.organizationId))
      .map(membership => structuredClone(membership));
  }

  async listActiveOrganizationsForUser(userId: string): Promise<readonly OrganizationRecord[]> {
    return [...this.memberships.values()]
      .filter(membership => membership.userId === userId && membership.status === "active")
      .map(membership => this.organizations.get(membership.organizationId))
      .filter((organization): organization is OrganizationRecord => Boolean(organization))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
      .map(organization => structuredClone(organization));
  }

  async listMemberships(organizationId: string, limit = 100): Promise<readonly OrganizationMembershipView[]> {
    this.requireOrganization(organizationId);
    const take = listLimit(limit);
    return [...this.memberships.values()]
      .filter(membership => membership.organizationId === organizationId)
      .sort((left, right) => left.userId.localeCompare(right.userId))
      .slice(0, take)
      .map(membership => {
        const user = this.requireUser(membership.userId);
        const identity = this.verifiedIdentityForUser(membership.userId);
        return {
          ...structuredClone(membership),
          ...(user.displayName ? { displayName: user.displayName } : {}),
          ...(identity?.email ? { verifiedEmail: identity.email } : {}),
        };
      });
  }

  async createInvitation(input: {
    organizationId: string;
    email: string;
    expiresAt: string;
    invitedBy: string;
  }): Promise<OrganizationInvitationRecord> {
    this.requireOrganization(input.organizationId);
    const now = this.now();
    const expiresAt = validDate(input.expiresAt, "expiresAt");
    if (expiresAt.getTime() <= now.getTime()) throw new RangeError("expiresAt must be in the future");
    const email = normalizeEmail(input.email);
    const invitedBy = requiredText(input.invitedBy, "invitedBy");
    const pending = [...this.invitations.values()]
      .filter(invitation => invitation.organizationId === input.organizationId
        && invitation.email === email
        && !invitation.acceptedAt
        && !invitation.revokedAt);
    const existing = pending.filter(invitation => Date.parse(invitation.expiresAt) > now.getTime());
    if (existing.length > 1) throw new OrganizationInvitationConflictError(input.organizationId, email);
    if (existing.length === 1) return publicInvitation(existing[0]!, now);
    for (const expired of pending) {
      expired.revokedAt = now.toISOString();
      expired.revokedBy = SYSTEM_EXPIRED_INVITATION_REVOKER;
      expired.updatedAt = now.toISOString();
    }
    const invitation: StoredOrganizationInvitation = {
      id: randomUUID(),
      organizationId: input.organizationId,
      email,
      expiresAt: expiresAt.toISOString(),
      invitedBy,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.invitations.set(invitation.id, invitation);
    return publicInvitation(invitation, now);
  }

  async listInvitations(organizationId: string, limit = 100): Promise<readonly OrganizationInvitationRecord[]> {
    this.requireOrganization(organizationId);
    const now = this.now();
    return [...this.invitations.values()]
      .filter(invitation => invitation.organizationId === organizationId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, listLimit(limit))
      .map(invitation => publicInvitation(invitation, now));
  }

  async revokeInvitation(input: {
    organizationId: string;
    invitationId: string;
    revokedBy: string;
  }): Promise<boolean> {
    this.requireOrganization(input.organizationId);
    const invitation = this.invitations.get(input.invitationId);
    if (!invitation || invitation.organizationId !== input.organizationId || invitation.acceptedAt || invitation.revokedAt) return false;
    const revokedBy = requiredText(input.revokedBy, "revokedBy");
    const now = this.now().toISOString();
    invitation.revokedAt = now;
    invitation.revokedBy = revokedBy;
    invitation.updatedAt = now;
    return true;
  }

  async acceptUniqueInvitation(input: {
    userId: string;
    verifiedEmail: string;
    organizationId?: string;
  }): Promise<AcceptedOrganizationInvitation> {
    this.requireUser(input.userId);
    if (input.organizationId !== undefined) this.requireOrganization(input.organizationId);
    const email = normalizeEmail(input.verifiedEmail);
    if (!this.hasVerifiedIdentity(input.userId, email)) {
      throw new OrganizationInvitationResolutionError("organization_invitation_identity_mismatch");
    }
    if (input.organizationId === undefined
      && [...this.memberships.values()].some(membership => membership.userId === input.userId && membership.status === "active")) {
      throw new OrganizationInvitationResolutionError("organization_invitation_membership_conflict");
    }
    const now = this.now();
    const candidates = [...this.invitations.values()]
      .filter(invitation => invitation.email === email
        && !invitation.acceptedAt
        && !invitation.revokedAt
        && Date.parse(invitation.expiresAt) > now.getTime()
        && (input.organizationId === undefined || invitation.organizationId === input.organizationId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    if (candidates.length === 0) {
      throw new OrganizationInvitationResolutionError("organization_invitation_required");
    }
    if (candidates.length !== 1) {
      throw new OrganizationInvitationResolutionError("organization_invitation_ambiguous");
    }
    const invitation = candidates[0]!;
    const key = membershipKey(invitation.organizationId, input.userId);
    if (this.memberships.has(key)) {
      throw new OrganizationInvitationResolutionError("organization_invitation_membership_conflict");
    }
    const acceptedAt = now.toISOString();
    const membership: MembershipRecord = {
      organizationId: invitation.organizationId,
      userId: input.userId,
      status: "active",
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    };
    invitation.acceptedAt = acceptedAt;
    invitation.acceptedByUserId = input.userId;
    invitation.updatedAt = acceptedAt;
    this.memberships.set(key, membership);
    return {
      invitation: publicInvitation(invitation, now),
      membership: structuredClone(membership),
    };
  }

  async verifyDomain(input: { organizationId: string; domain: string; verifiedAt?: string }): Promise<VerifiedDomainRecord> {
    this.requireOrganization(input.organizationId);
    const domain = normalizeDomain(input.domain);
    const existing = this.verifiedDomains.get(domain);
    if (existing) {
      if (existing.organizationId !== input.organizationId) throw new VerifiedDomainConflictError(domain);
      return structuredClone(existing);
    }
    const createdAt = this.now().toISOString();
    const domainRecord: VerifiedDomainRecord = {
      organizationId: input.organizationId,
      domain,
      verifiedAt: input.verifiedAt === undefined ? createdAt : validDate(input.verifiedAt, "verifiedAt").toISOString(),
      createdAt,
    };
    this.verifiedDomains.set(domain, domainRecord);
    return structuredClone(domainRecord);
  }

  async discoverOrganizationsForIdentity(providerInput: string, subjectInput: string): Promise<readonly OrganizationRecord[]> {
    const identity = this.identities.get(identityKey(normalizeProvider(providerInput), requiredText(subjectInput, "subject")));
    if (!identity?.emailVerified || !identity.email) return [];
    const domainRecord = this.verifiedDomains.get(emailDomain(identity.email));
    const organization = domainRecord ? this.organizations.get(domainRecord.organizationId) : undefined;
    return organization ? [structuredClone(organization)] : [];
  }

  async createBrowserSession(input: { organizationId: string; userId: string; expiresAt: string }): Promise<CreatedBrowserSession> {
    const membership = this.memberships.get(membershipKey(input.organizationId, input.userId));
    if (membership?.status !== "active") throw new ActiveMembershipRequiredError(input.organizationId, input.userId);
    const now = this.now();
    const expiresAt = validDate(input.expiresAt, "expiresAt");
    if (expiresAt.getTime() <= now.getTime()) throw new RangeError("expiresAt must be in the future");
    const id = randomUUID();
    const token = sessionToken(id);
    const session: StoredBrowserSession = {
      id,
      organizationId: input.organizationId,
      userId: input.userId,
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.sessions.set(id, session);
    return { token, session: publicSession(session) };
  }

  async authenticateBrowserSession(token: string): Promise<AuthenticatedBrowserSession | undefined> {
    const id = sessionId(token);
    const session = id ? this.sessions.get(id) : undefined;
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= this.now().getTime()
      || !hashesEqual(session.tokenHash, hashToken(token))) return undefined;
    const membership = this.memberships.get(membershipKey(session.organizationId, session.userId));
    const user = this.users.get(session.userId);
    if (membership?.status !== "active" || !user) return undefined;
    session.lastSeenAt = this.now().toISOString();
    return {
      session: publicSession(session),
      membership: structuredClone(membership),
      user: structuredClone(user),
    };
  }

  async revokeBrowserSession(scope: OwnerScope, sessionIdInput: string): Promise<boolean> {
    const organizationId = organizationScope(scope).tenantId;
    const session = this.sessions.get(sessionIdInput);
    if (!session || session.organizationId !== organizationId || session.revokedAt) return false;
    session.revokedAt = this.now().toISOString();
    return true;
  }

  async revokeUserSessions(userId: string): Promise<number> {
    return this.revokeWhere(session => session.userId === userId);
  }

  async revokeOrganizationSessions(organizationId: string): Promise<number> {
    return this.revokeWhere(session => session.organizationId === organizationId);
  }

  async revokeAllSessions(): Promise<number> {
    return this.revokeWhere(() => true);
  }

  async close(): Promise<void> {}

  private requireOrganization(id: string): OrganizationRecord {
    const organization = this.organizations.get(id);
    if (!organization) throw new OrganizationStoreNotFoundError("organization", id);
    return organization;
  }

  private requireUser(id: string): UserRecord {
    const user = this.users.get(id);
    if (!user) throw new OrganizationStoreNotFoundError("user", id);
    return user;
  }

  private verifiedIdentityForUser(userId: string): UserIdentityRecord | undefined {
    return [...this.identities.values()]
      .filter(identity => identity.userId === userId && identity.emailVerified && identity.email)
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.subject.localeCompare(right.subject))[0];
  }

  private hasVerifiedIdentity(userId: string, email: string): boolean {
    return [...this.identities.values()].some(identity => identity.userId === userId
      && identity.emailVerified
      && identity.email === email);
  }

  private revokeMembershipSessionsAt(organizationId: string, userId: string, revokedAt: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.organizationId === organizationId && session.userId === userId && !session.revokedAt) {
        session.revokedAt = revokedAt;
        count += 1;
      }
    }
    return count;
  }

  private revokeWhere(predicate: (session: StoredBrowserSession) => boolean): number {
    const revokedAt = this.now().toISOString();
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.revokedAt && predicate(session)) {
        session.revokedAt = revokedAt;
        count += 1;
      }
    }
    return count;
  }
}

export class PrismaOrganizationStore implements OrganizationStore {
  private initialized?: Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly prisma: PrismaClient, options: OrganizationStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  init(): Promise<void> {
    this.initialized ??= this.prisma.$connect();
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PrismaOrganizationStore has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async createOrganization(input: { id?: string; slug: string; displayName: string }): Promise<OrganizationRecord> {
    await this.ready();
    const slug = normalizeSlug(input.slug);
    const id = input.id === undefined ? randomUUID() : requiredText(input.id, "id");
    const now = this.now();
    try {
      const row = await this.prisma.platformOrganization.create({ data: {
        id,
        slug,
        displayName: requiredText(input.displayName, "displayName"),
        createdAt: now,
        updatedAt: now,
      } });
      return rowToOrganization(row);
    } catch (error) {
      if (isPrismaUniqueViolation(error)) throw new OrganizationStoreConflictError("slug", slug);
      throw error;
    }
  }

  async ensureOrganization(input: { id: string; slug: string; displayName: string }): Promise<OrganizationRecord> {
    await this.ready();
    const id = requiredText(input.id, "id");
    const existing = await this.prisma.platformOrganization.findUnique({ where: { id } });
    if (existing) return rowToOrganization(existing);
    try {
      return await this.createOrganization({ ...input, id });
    } catch (error) {
      if (!(error instanceof OrganizationStoreConflictError)) throw error;
      const concurrent = await this.prisma.platformOrganization.findUnique({ where: { id } });
      if (concurrent) return rowToOrganization(concurrent);
      throw error;
    }
  }

  async createUser(input: { displayName?: string }): Promise<UserRecord> {
    await this.ready();
    const now = this.now();
    const row = await this.prisma.platformUser.create({ data: {
      id: randomUUID(),
      ...(input.displayName === undefined ? {} : { displayName: requiredText(input.displayName, "displayName") }),
      createdAt: now,
      updatedAt: now,
    } });
    return rowToUser(row);
  }

  async linkIdentity(input: {
    userId: string;
    provider: string;
    subject: string;
    email?: string;
    emailVerified: boolean;
  }): Promise<UserIdentityRecord> {
    await this.ready();
    const provider = normalizeProvider(input.provider);
    const subject = requiredText(input.subject, "subject");
    try {
      const row = await this.prisma.$transaction(async tx => {
        const user = await tx.platformUser.findUnique({ where: { id: input.userId }, select: { id: true } });
        if (!user) throw new OrganizationStoreNotFoundError("user", input.userId);
        const existing = await tx.platformUserIdentity.findUnique({
          where: { provider_providerSubject: { provider, providerSubject: subject } },
        });
        if (existing) {
          if (existing.userId !== input.userId) throw new IdentityAlreadyLinkedError(provider, subject);
          return existing;
        }
        const now = this.now();
        return tx.platformUserIdentity.create({ data: {
          userId: input.userId,
          provider,
          providerSubject: subject,
          ...(input.email === undefined ? {} : { email: normalizeEmail(input.email) }),
          emailVerified: input.emailVerified,
          createdAt: now,
          updatedAt: now,
        } });
      }, { isolationLevel: "Serializable" });
      return rowToIdentity(row);
    } catch (error) {
      if (error instanceof OrganizationStoreNotFoundError || error instanceof IdentityAlreadyLinkedError) throw error;
      if (isPrismaUniqueViolation(error)) throw new IdentityAlreadyLinkedError(provider, subject);
      throw error;
    }
  }

  async resolveIdentity(providerInput: string, subjectInput: string): Promise<{ user: UserRecord; identity: UserIdentityRecord } | undefined> {
    await this.ready();
    const provider = normalizeProvider(providerInput);
    const subject = requiredText(subjectInput, "subject");
    const row = await this.prisma.platformUserIdentity.findUnique({
      where: { provider_providerSubject: { provider, providerSubject: subject } },
      include: { user: true },
    });
    return row ? { identity: rowToIdentity(row), user: rowToUser(row.user) } : undefined;
  }

  async resolveIdentityForUser(userId: string, providerInput: string): Promise<UserIdentityRecord | undefined> {
    await this.ready();
    const row = await this.prisma.platformUserIdentity.findUnique({
      where: { userId_provider: { userId, provider: normalizeProvider(providerInput) } },
    });
    return row ? rowToIdentity(row) : undefined;
  }

  async resolveOrCreateIdentity(input: ResolveOrCreateIdentityInput): Promise<{ user: UserRecord; identity: UserIdentityRecord }> {
    await this.ready();
    const provider = normalizeProvider(input.provider);
    const subject = requiredText(input.subject, "subject");
    try {
      const result = await this.prisma.$transaction(async tx => {
        const existing = await tx.platformUserIdentity.findUnique({
          where: { provider_providerSubject: { provider, providerSubject: subject } },
          include: { user: true },
        });
        const now = this.now();
        if (existing) {
          const identity = await tx.platformUserIdentity.update({
            where: { provider_providerSubject: { provider, providerSubject: subject } },
            data: {
              ...(input.email === undefined ? {} : { email: normalizeEmail(input.email) }),
              emailVerified: input.emailVerified,
              updatedAt: now,
            },
          });
          const user = input.displayName === undefined
            ? existing.user
            : await tx.platformUser.update({
              where: { id: existing.userId },
              data: { displayName: requiredText(input.displayName, "displayName"), updatedAt: now },
            });
          return { identity, user };
        }
        const user = await tx.platformUser.create({ data: {
          id: randomUUID(),
          ...(input.displayName === undefined ? {} : { displayName: requiredText(input.displayName, "displayName") }),
          createdAt: now,
          updatedAt: now,
        } });
        const identity = await tx.platformUserIdentity.create({ data: {
          userId: user.id,
          provider,
          providerSubject: subject,
          ...(input.email === undefined ? {} : { email: normalizeEmail(input.email) }),
          emailVerified: input.emailVerified,
          createdAt: now,
          updatedAt: now,
        } });
        return { identity, user };
      }, { isolationLevel: "Serializable" });
      return { identity: rowToIdentity(result.identity), user: rowToUser(result.user) };
    } catch (error) {
      if (!isPrismaUniqueViolation(error)) throw error;
      const concurrent = await this.resolveIdentity(provider, subject);
      if (concurrent) return concurrent;
      throw error;
    }
  }

  async registerPasswordUser(input: {
    organizationId: string;
    email: string;
    passwordHash: string;
    displayName?: string;
  }): Promise<RegisteredPasswordUser> {
    await this.ready();
    const email = normalizeEmail(input.email);
    try {
      const result = await this.prisma.$transaction(async tx => {
        const organization = await tx.platformOrganization.findUnique({
          where: { id: input.organizationId },
          select: { id: true },
        });
        if (!organization) throw new OrganizationStoreNotFoundError("organization", input.organizationId);
        const existing = await tx.platformUserIdentity.findUnique({
          where: { provider_providerSubject: { provider: "password", providerSubject: email } },
          select: { userId: true },
        });
        if (existing) throw new PasswordIdentityAlreadyExistsError();
        const now = this.now();
        const user = await tx.platformUser.create({ data: {
          id: randomUUID(),
          ...(input.displayName === undefined ? {} : { displayName: requiredText(input.displayName, "displayName") }),
          createdAt: now,
          updatedAt: now,
        } });
        const identity = await tx.platformUserIdentity.create({ data: {
          userId: user.id,
          provider: "password",
          providerSubject: email,
          email,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        } });
        const credential = await tx.platformPasswordCredential.create({ data: {
          userId: user.id,
          passwordHash: passwordHashText(input.passwordHash),
          createdAt: now,
          updatedAt: now,
        } });
        const membership = await tx.platformOrganizationMembership.create({ data: {
          organizationId: input.organizationId,
          userId: user.id,
          status: "active",
          createdAt: now,
          updatedAt: now,
        } });
        return { user, identity, credential, membership };
      }, { isolationLevel: "Serializable" });
      return {
        user: rowToUser(result.user),
        identity: rowToIdentity(result.identity),
        credential: rowToPasswordCredential(result.credential),
        membership: rowToMembership(result.membership),
      };
    } catch (error) {
      if (error instanceof OrganizationStoreNotFoundError || error instanceof PasswordIdentityAlreadyExistsError) throw error;
      if (isPrismaUniqueViolation(error)) throw new PasswordIdentityAlreadyExistsError();
      throw error;
    }
  }

  async resolvePasswordCredential(emailInput: string): Promise<{
    user: UserRecord;
    identity: UserIdentityRecord;
    credential: PasswordCredentialRecord;
  } | undefined> {
    await this.ready();
    const identity = await this.prisma.platformUserIdentity.findUnique({
      where: { provider_providerSubject: { provider: "password", providerSubject: normalizeEmail(emailInput) } },
      include: { user: { include: { passwordCredential: true } } },
    });
    if (!identity?.user.passwordCredential) return undefined;
    return {
      identity: rowToIdentity(identity),
      user: rowToUser(identity.user),
      credential: rowToPasswordCredential(identity.user.passwordCredential),
    };
  }

  async updateMembershipStatus(scope: OwnerScope, input: {
    organizationId: string;
    userId: string;
    status: MembershipStatus;
  }): Promise<MembershipRecord> {
    assertOrganizationScope(scope, input.organizationId);
    await this.ready();
    const status = membershipStatus(input.status);
    // This transaction must stay Serializable so a concurrent session create
    // cannot slip in after the revocation scan. Retry only P2034 and rerun the
    // entire transaction when authentication traffic briefly wins the race.
    const row = await retryPrismaSerializationFailure(() => this.prisma.$transaction(async tx => {
      const identity = { organizationId: input.organizationId, userId: input.userId };
      const existing = await tx.platformOrganizationMembership.findUnique({
        where: { organizationId_userId: identity },
        select: { organizationId: true, userId: true },
      });
      if (!existing) throw new OrganizationMembershipNotFoundError();
      const now = this.now();
      const membership = await tx.platformOrganizationMembership.update({
        where: { organizationId_userId: identity },
        data: { status, updatedAt: now },
      });
      if (status !== "active") {
        await tx.platformBrowserSession.updateMany({
          where: { organizationId: input.organizationId, userId: input.userId, revokedAt: null },
          data: { revokedAt: now },
        });
      }
      return membership;
    }, { isolationLevel: "Serializable" }));
    return rowToMembership(row);
  }

  async grantBootstrapMembership(input: { organizationId: string; userId: string }): Promise<MembershipRecord> {
    await this.ready();
    const row = await this.prisma.$transaction(async tx => {
      const organization = await tx.platformOrganization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
      if (!organization) throw new OrganizationStoreNotFoundError("organization", input.organizationId);
      const user = await tx.platformUser.findUnique({ where: { id: input.userId }, select: { id: true } });
      if (!user) throw new OrganizationStoreNotFoundError("user", input.userId);
      const now = this.now();
      return tx.platformOrganizationMembership.upsert({
        where: { organizationId_userId: { organizationId: input.organizationId, userId: input.userId } },
        create: { organizationId: input.organizationId, userId: input.userId, status: "active", createdAt: now, updatedAt: now },
        update: { status: "active", updatedAt: now },
      });
    }, { isolationLevel: "Serializable" });
    return rowToMembership(row);
  }

  async resolveActiveMembership(organizationId: string, userId: string): Promise<MembershipRecord | undefined> {
    await this.ready();
    const row = await this.prisma.platformOrganizationMembership.findFirst({
      where: { organizationId, userId, status: "active" },
    });
    return row?.status === "active" ? rowToMembership(row) : undefined;
  }

  async resolveMembership(organizationId: string, userId: string): Promise<MembershipRecord | undefined> {
    await this.ready();
    const row = await this.prisma.platformOrganizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    return row ? rowToMembership(row) : undefined;
  }

  async listActiveMembershipsForUser(userId: string): Promise<readonly MembershipRecord[]> {
    await this.ready();
    const rows = await this.prisma.platformOrganizationMembership.findMany({
      where: { userId, status: "active" },
      orderBy: { organizationId: "asc" },
    });
    return rows.map(rowToMembership);
  }

  async listActiveOrganizationsForUser(userId: string): Promise<readonly OrganizationRecord[]> {
    await this.ready();
    const rows = await this.prisma.platformOrganizationMembership.findMany({
      where: { userId, status: "active" },
      orderBy: [
        { organization: { displayName: "asc" } },
        { organizationId: "asc" },
      ],
      include: { organization: true },
    });
    return rows.map(row => rowToOrganization(row.organization));
  }

  async listMemberships(organizationId: string, limit = 100): Promise<readonly OrganizationMembershipView[]> {
    await this.ready();
    const organization = await this.prisma.platformOrganization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!organization) throw new OrganizationStoreNotFoundError("organization", organizationId);
    const rows = await this.prisma.platformOrganizationMembership.findMany({
      where: { organizationId },
      orderBy: { userId: "asc" },
      take: listLimit(limit),
      include: { user: { include: { identities: true } } },
    });
    return rows.map(row => {
      const identity = row.user.identities
        .filter(candidate => candidate.emailVerified && candidate.email)
        .sort((left, right) => left.provider.localeCompare(right.provider)
          || left.providerSubject.localeCompare(right.providerSubject))[0];
      return {
        ...rowToMembership(row),
        ...(row.user.displayName ? { displayName: row.user.displayName } : {}),
        ...(identity?.email ? { verifiedEmail: identity.email } : {}),
      };
    });
  }

  async createInvitation(input: {
    organizationId: string;
    email: string;
    expiresAt: string;
    invitedBy: string;
  }): Promise<OrganizationInvitationRecord> {
    await this.ready();
    const now = this.now();
    const expiresAt = validDate(input.expiresAt, "expiresAt");
    if (expiresAt.getTime() <= now.getTime()) throw new RangeError("expiresAt must be in the future");
    const email = normalizeEmail(input.email);
    const invitedBy = requiredText(input.invitedBy, "invitedBy");
    try {
      const row = await this.prisma.$transaction(async tx => {
        const organization = await tx.platformOrganization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
        if (!organization) throw new OrganizationStoreNotFoundError("organization", input.organizationId);
        await tx.platformOrganizationInvitation.updateMany({
          where: {
            organizationId: input.organizationId,
            email,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { lte: now },
          },
          data: { revokedAt: now, revokedBy: SYSTEM_EXPIRED_INVITATION_REVOKER, updatedAt: now },
        });
        const existing = await tx.platformOrganizationInvitation.findMany({
          where: {
            organizationId: input.organizationId,
            email,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          orderBy: { createdAt: "asc" },
          take: 2,
        });
        if (existing.length > 1) throw new OrganizationInvitationConflictError(input.organizationId, email);
        if (existing.length === 1) return existing[0]!;
        return tx.platformOrganizationInvitation.create({ data: {
          id: randomUUID(),
          organizationId: input.organizationId,
          email,
          expiresAt,
          invitedBy,
          createdAt: now,
          updatedAt: now,
        } });
      }, { isolationLevel: "Serializable" });
      return rowToInvitation(row, now);
    } catch (error) {
      if (error instanceof OrganizationStoreNotFoundError || error instanceof OrganizationInvitationConflictError) throw error;
      if (!isPrismaUniqueViolation(error) && !isPrismaSerializationFailure(error)) throw error;
      const concurrent = await this.prisma.platformOrganizationInvitation.findMany({
        where: {
          organizationId: input.organizationId,
          email,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: this.now() },
        },
        orderBy: { createdAt: "asc" },
        take: 2,
      });
      if (concurrent.length === 1) return rowToInvitation(concurrent[0]!, this.now());
      throw new OrganizationInvitationConflictError(input.organizationId, email);
    }
  }

  async listInvitations(organizationId: string, limit = 100): Promise<readonly OrganizationInvitationRecord[]> {
    await this.ready();
    const organization = await this.prisma.platformOrganization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!organization) throw new OrganizationStoreNotFoundError("organization", organizationId);
    const now = this.now();
    const rows = await this.prisma.platformOrganizationInvitation.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: listLimit(limit),
    });
    return rows.map(row => rowToInvitation(row, now));
  }

  async revokeInvitation(input: {
    organizationId: string;
    invitationId: string;
    revokedBy: string;
  }): Promise<boolean> {
    await this.ready();
    const now = this.now();
    const result = await this.prisma.platformOrganizationInvitation.updateMany({
      where: {
        id: input.invitationId,
        organizationId: input.organizationId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: now,
        revokedBy: requiredText(input.revokedBy, "revokedBy"),
        updatedAt: now,
      },
    });
    return result.count === 1;
  }

  async acceptUniqueInvitation(input: {
    userId: string;
    verifiedEmail: string;
    organizationId?: string;
  }): Promise<AcceptedOrganizationInvitation> {
    await this.ready();
    const email = normalizeEmail(input.verifiedEmail);
    const organizationId = input.organizationId === undefined
      ? undefined
      : requiredText(input.organizationId, "organizationId");
    try {
      return await this.prisma.$transaction(async tx => {
        const identity = await tx.platformUserIdentity.findFirst({
          where: { userId: input.userId, email, emailVerified: true },
          select: { userId: true },
        });
        if (!identity) {
          throw new OrganizationInvitationResolutionError("organization_invitation_identity_mismatch");
        }
        if (organizationId === undefined) {
          const activeMembership = await tx.platformOrganizationMembership.findFirst({
            where: { userId: input.userId, status: "active" },
            select: { organizationId: true },
          });
          if (activeMembership) {
            throw new OrganizationInvitationResolutionError("organization_invitation_membership_conflict");
          }
        }
        const now = this.now();
        const candidates = await tx.platformOrganizationInvitation.findMany({
          where: {
            email,
            ...(organizationId === undefined ? {} : { organizationId }),
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          orderBy: { createdAt: "asc" },
          take: 2,
        });
        if (candidates.length === 0) {
          throw new OrganizationInvitationResolutionError("organization_invitation_required");
        }
        if (candidates.length !== 1) {
          throw new OrganizationInvitationResolutionError("organization_invitation_ambiguous");
        }
        const invitation = candidates[0]!;
        const existingMembership = await tx.platformOrganizationMembership.findUnique({
          where: { organizationId_userId: { organizationId: invitation.organizationId, userId: input.userId } },
          select: { status: true },
        });
        if (existingMembership) {
          throw new OrganizationInvitationResolutionError("organization_invitation_membership_conflict");
        }
        const accepted = await tx.platformOrganizationInvitation.updateMany({
          where: {
            id: invitation.id,
            organizationId: invitation.organizationId,
            email,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { acceptedAt: now, acceptedByUserId: input.userId, updatedAt: now },
        });
        if (accepted.count !== 1) {
          throw new OrganizationInvitationResolutionError("organization_invitation_concurrent_conflict");
        }
        const membership = await tx.platformOrganizationMembership.create({ data: {
          organizationId: invitation.organizationId,
          userId: input.userId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        } });
        const acceptedInvitation = await tx.platformOrganizationInvitation.findUnique({ where: { id: invitation.id } });
        if (!acceptedInvitation) {
          throw new OrganizationInvitationResolutionError("organization_invitation_concurrent_conflict");
        }
        return {
          invitation: rowToInvitation(acceptedInvitation, now),
          membership: rowToMembership(membership),
        };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (error instanceof OrganizationInvitationResolutionError) throw error;
      if (isPrismaSerializationFailure(error)) {
        throw new OrganizationInvitationResolutionError("organization_invitation_concurrent_conflict");
      }
      if (isPrismaUniqueViolation(error)) {
        throw new OrganizationInvitationResolutionError("organization_invitation_membership_conflict");
      }
      throw error;
    }
  }

  async verifyDomain(input: { organizationId: string; domain: string; verifiedAt?: string }): Promise<VerifiedDomainRecord> {
    await this.ready();
    const domain = normalizeDomain(input.domain);
    try {
      const row = await this.prisma.$transaction(async tx => {
        const organization = await tx.platformOrganization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
        if (!organization) throw new OrganizationStoreNotFoundError("organization", input.organizationId);
        const existing = await tx.platformOrganizationDomain.findUnique({ where: { domain } });
        if (existing) {
          if (existing.organizationId !== input.organizationId) throw new VerifiedDomainConflictError(domain);
          return existing;
        }
        const createdAt = this.now();
        return tx.platformOrganizationDomain.create({ data: {
          organizationId: input.organizationId,
          domain,
          verifiedAt: input.verifiedAt === undefined ? createdAt : validDate(input.verifiedAt, "verifiedAt"),
          createdAt,
        } });
      }, { isolationLevel: "Serializable" });
      return rowToDomain(row);
    } catch (error) {
      if (error instanceof OrganizationStoreNotFoundError || error instanceof VerifiedDomainConflictError) throw error;
      if (isPrismaUniqueViolation(error)) throw new VerifiedDomainConflictError(domain);
      throw error;
    }
  }

  async discoverOrganizationsForIdentity(providerInput: string, subjectInput: string): Promise<readonly OrganizationRecord[]> {
    await this.ready();
    const identity = await this.prisma.platformUserIdentity.findUnique({
      where: { provider_providerSubject: {
        provider: normalizeProvider(providerInput),
        providerSubject: requiredText(subjectInput, "subject"),
      } },
    });
    if (!identity?.emailVerified || !identity.email) return [];
    const domain = await this.prisma.platformOrganizationDomain.findUnique({
      where: { domain: emailDomain(identity.email) },
      include: { organization: true },
    });
    return domain ? [rowToOrganization(domain.organization)] : [];
  }

  async createBrowserSession(input: { organizationId: string; userId: string; expiresAt: string }): Promise<CreatedBrowserSession> {
    await this.ready();
    const now = this.now();
    const expiresAt = validDate(input.expiresAt, "expiresAt");
    if (expiresAt.getTime() <= now.getTime()) throw new RangeError("expiresAt must be in the future");
    const id = randomUUID();
    const token = sessionToken(id);
    const row = await this.prisma.$transaction(async tx => {
      const membership = await tx.platformOrganizationMembership.findFirst({
        where: { organizationId: input.organizationId, userId: input.userId, status: "active" },
      });
      if (!membership) throw new ActiveMembershipRequiredError(input.organizationId, input.userId);
      return tx.platformBrowserSession.create({ data: {
        id,
        organizationId: input.organizationId,
        userId: input.userId,
        tokenHash: Uint8Array.from(hashToken(token)),
        createdAt: now,
        expiresAt,
      } });
    }, { isolationLevel: "Serializable" });
    return { token, session: rowToSession(row) };
  }

  async authenticateBrowserSession(token: string): Promise<AuthenticatedBrowserSession | undefined> {
    const id = sessionId(token);
    if (!id) return undefined;
    await this.ready();
    const now = this.now();
    return this.prisma.$transaction(async tx => {
      const row = await tx.platformBrowserSession.findUnique({
        where: { id },
        include: { membership: { include: { user: true } } },
      });
      if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime() || row.membership.status !== "active"
        || !hashesEqual(Buffer.from(row.tokenHash), hashToken(token))) return undefined;

      // Authentication is a hot read path. Serializable isolation made every
      // parallel API request contend while touching the same session row and
      // surfaced normal browser concurrency as Prisma P2034 errors. Explicit
      // ReadCommitted keeps the revoke/expiry recheck atomic while letting
      // PostgreSQL serialize concurrent row updates without aborting requests.
      const touched = await tx.platformBrowserSession.updateMany({
        where: {
          id,
          organizationId: row.organizationId,
          userId: row.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { lastSeenAt: now },
      });
      if (touched.count !== 1) return undefined;
      return {
        session: rowToSession({ ...row, lastSeenAt: now }),
        membership: rowToMembership(row.membership),
        user: rowToUser(row.membership.user),
      };
    }, { isolationLevel: "ReadCommitted" });
  }

  async revokeBrowserSession(scope: OwnerScope, sessionIdInput: string): Promise<boolean> {
    const organizationId = organizationScope(scope).tenantId;
    await this.ready();
    const result = await this.prisma.platformBrowserSession.updateMany({
      where: { id: sessionIdInput, organizationId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
    return result.count === 1;
  }

  async revokeUserSessions(userId: string): Promise<number> {
    await this.ready();
    const result = await this.prisma.platformBrowserSession.updateMany({
      where: { userId, revokedAt: null }, data: { revokedAt: this.now() },
    });
    return result.count;
  }

  async revokeOrganizationSessions(organizationId: string): Promise<number> {
    await this.ready();
    const result = await this.prisma.platformBrowserSession.updateMany({
      where: { organizationId, revokedAt: null }, data: { revokedAt: this.now() },
    });
    return result.count;
  }

  async revokeAllSessions(): Promise<number> {
    await this.ready();
    const result = await this.prisma.platformBrowserSession.updateMany({
      where: { revokedAt: null }, data: { revokedAt: this.now() },
    });
    return result.count;
  }

  async close(): Promise<void> {
    // The shared Prisma client is owned by the runtime lifecycle.
  }
}

function rowToOrganization(row: PrismaOrganization): OrganizationRecord {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToUser(row: PrismaUser): UserRecord {
  return {
    id: row.id,
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToIdentity(row: PrismaUserIdentity): UserIdentityRecord {
  return {
    userId: row.userId,
    provider: row.provider,
    subject: row.providerSubject,
    ...(row.email === null ? {} : { email: row.email }),
    emailVerified: row.emailVerified,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToPasswordCredential(row: PrismaPasswordCredential): PasswordCredentialRecord {
  return {
    userId: row.userId,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToMembership(row: PrismaOrganizationMembership): MembershipRecord {
  return {
    organizationId: row.organizationId,
    userId: row.userId,
    status: membershipStatus(row.status),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToDomain(row: PrismaOrganizationDomain): VerifiedDomainRecord {
  return {
    organizationId: row.organizationId,
    domain: row.domain,
    verifiedAt: row.verifiedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToInvitation(row: PrismaOrganizationInvitation, now: Date): OrganizationInvitationRecord {
  return publicInvitation({
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    expiresAt: row.expiresAt.toISOString(),
    invitedBy: row.invitedBy,
    ...(row.acceptedAt === null ? {} : { acceptedAt: row.acceptedAt.toISOString() }),
    ...(row.acceptedByUserId === null ? {} : { acceptedByUserId: row.acceptedByUserId }),
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt.toISOString() }),
    ...(row.revokedBy === null ? {} : { revokedBy: row.revokedBy }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }, now);
}

function rowToSession(row: PrismaBrowserSession): BrowserSessionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.lastSeenAt === null ? {} : { lastSeenAt: row.lastSeenAt.toISOString() }),
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt.toISOString() }),
  };
}

function publicSession(session: StoredBrowserSession): BrowserSessionRecord {
  const { tokenHash: _, ...record } = session;
  return structuredClone(record);
}

function publicInvitation(invitation: StoredOrganizationInvitation, now: Date): OrganizationInvitationRecord {
  const status: OrganizationInvitationStatus = invitation.acceptedAt
    ? "accepted"
    : invitation.revokedAt
      ? "revoked"
      : Date.parse(invitation.expiresAt) <= now.getTime()
        ? "expired"
        : "pending";
  return structuredClone({ ...invitation, status });
}

function sessionToken(id: string): string {
  return `qsy_session_${id}_${randomBytes(32).toString("base64url")}`;
}

function sessionId(token: string): string | undefined {
  return SESSION_TOKEN_PATTERN.exec(token)?.[1];
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function hashesEqual(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function identityKey(provider: string, subject: string): string {
  return JSON.stringify([provider, subject]);
}

function membershipKey(organizationId: string, userId: string): string {
  return JSON.stringify([organizationId, userId]);
}

function normalizeSlug(input: string): string {
  const slug = requiredText(input, "slug").toLowerCase();
  if (!SLUG_PATTERN.test(slug)) throw new RangeError("slug must contain only lowercase letters, digits, or interior hyphens");
  return slug;
}

function normalizeProvider(input: string): string {
  return requiredText(input, "provider").toLowerCase();
}

function normalizeDomain(input: string): string {
  const domain = requiredText(input, "domain").toLowerCase().replace(/\.$/u, "");
  if (!DOMAIN_PATTERN.test(domain)) throw new RangeError("domain must be a valid DNS name");
  return domain;
}

function normalizeEmail(input: string): string {
  const email = requiredText(input, "email").toLowerCase();
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) throw new RangeError("email must be valid");
  normalizeDomain(email.slice(separator + 1));
  return email;
}

function emailDomain(email: string): string {
  return normalizeEmail(email).slice(normalizeEmail(email).lastIndexOf("@") + 1);
}

function membershipStatus(input: string): MembershipStatus {
  if (input === "active" || input === "suspended" || input === "removed") return input;
  throw new RangeError("membership status must be active, suspended, or removed");
}

function organizationScope(scope: OwnerScope): OwnerScope {
  return OwnerScopeSchema.parse(scope);
}

function assertOrganizationScope(scope: OwnerScope, organizationIdInput: string): OwnerScope {
  const owner = organizationScope(scope);
  if (owner.tenantId !== requiredText(organizationIdInput, "organizationId")) {
    throw new OrganizationScopeMismatchError();
  }
  return owner;
}

function requiredText(input: string, field: string): string {
  const value = input.trim();
  if (!value) throw new RangeError(`${field} must not be empty`);
  return value;
}

function passwordHashText(input: string): string {
  const value = requiredText(input, "passwordHash");
  if (value.length < 32 || value.length > 1_024) throw new RangeError("passwordHash must contain 32 to 1024 characters");
  return value;
}

function validDate(input: string, field: string): Date {
  const value = new Date(input);
  if (!Number.isFinite(value.getTime())) throw new RangeError(`${field} must be a valid date`);
  return value;
}

function listLimit(input: number): number {
  if (!Number.isInteger(input) || input < 1 || input > 500) throw new RangeError("limit must be an integer between 1 and 500");
  return input;
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function isPrismaSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2034";
}

async function retryPrismaSerializationFailure<T>(operation: () => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isPrismaSerializationFailure(error) || attempt >= maxAttempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 5 * (2 ** (attempt - 1))));
    }
  }
}
