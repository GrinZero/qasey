import type { AgentApplicationBundle, CatalogEntry, PrimitiveAccessPolicy } from "./application.ts";

const APPLICATION_ID = /^[a-z][a-z0-9-]*$/u;

export interface FlattenedApplicationRegistry {
  agents: AgentApplicationBundle["agents"];
  workflows: AgentApplicationBundle["workflows"];
  scorers: NonNullable<AgentApplicationBundle["scorers"]>;
  routes: NonNullable<AgentApplicationBundle["routes"]>[number]["route"][];
  catalog: readonly CatalogEntry[];
  publicRouteIds: ReadonlySet<string>;
}

export function flattenApplicationRegistry(
  applications: readonly AgentApplicationBundle[],
): FlattenedApplicationRegistry {
  const applicationIds = new Set<string>();
  const canonicalIds = new Map<string, string>();
  const agents: AgentApplicationBundle["agents"] = {};
  const workflows: AgentApplicationBundle["workflows"] = {};
  const scorers: NonNullable<AgentApplicationBundle["scorers"]> = {};
  const routes: FlattenedApplicationRegistry["routes"] = [];
  const catalog: CatalogEntry[] = [];
  const publicRouteIds = new Set<string>();

  for (const application of applications) {
    if (!APPLICATION_ID.test(application.id)) {
      throw new Error(`Invalid application id "${application.id}"; use lower-case kebab-case`);
    }
    if (applicationIds.has(application.id)) throw new Error(`Duplicate application id: ${application.id}`);
    applicationIds.add(application.id);

    mergeAgents(application, agents, canonicalIds, catalog);
    mergePrimitives(application, "workflow", application.workflows, application.access.workflows, workflows, canonicalIds, catalog);
    mergePrimitives(application, "scorer", application.scorers ?? {}, application.access.scorers ?? {}, scorers, canonicalIds, catalog);
    validateMetadataCoverage(application.id, "channel", application.access.channels ?? {}, catalog);
    validateMetadataCoverage(application.id, "protocol", application.access.protocols ?? {}, catalog);

    for (const ownedRoute of application.routes ?? []) {
      validatePolicy(`${application.id} route ${ownedRoute.id}`, ownedRoute.access);
      const qualifiedId = `${application.id}-${ownedRoute.id}`;
      claimCanonicalId(qualifiedId, `${application.id} route`, canonicalIds);
      routes.push(ownedRoute.route);
      catalog.push({
        applicationId: application.id,
        resourceType: "route",
        resourceId: qualifiedId,
        routePath: ownedRoute.route.path,
        routeMethod: ownedRoute.route.method,
        ...(ownedRoute.public ? { public: true } : {}),
        ...ownedRoute.access,
      });
      if (ownedRoute.public) publicRouteIds.add(qualifiedId);
    }
  }

  return { agents, workflows, scorers, routes, catalog, publicRouteIds };
}

function mergeAgents(
  application: AgentApplicationBundle,
  target: AgentApplicationBundle["agents"],
  canonicalIds: Map<string, string>,
  catalog: CatalogEntry[],
): void {
  const codeAgentIds = Object.keys(application.agents);
  const filesystemAgentIds = [...(application.filesystemAgents ?? [])];
  const duplicateDeclarations = filesystemAgentIds.filter(id => codeAgentIds.includes(id));
  if (duplicateDeclarations.length > 0) {
    throw new Error(`${application.id} agent declared as both code and filesystem registered: ${duplicateDeclarations.join(", ")}`);
  }

  const agentIds = [...codeAgentIds, ...filesystemAgentIds];
  validatePrimitiveAccessCoverage(application.id, "agent", agentIds, application.access.agents);

  for (const [registryKey, agent] of Object.entries(application.agents)) {
    validatePrimitiveIdentity(application, "agent", registryKey, agent.id, canonicalIds);
    target[registryKey] = agent;
    catalog.push({
      applicationId: application.id,
      resourceType: "agent",
      resourceId: registryKey,
      ...application.access.agents[registryKey]!,
    });
  }

  for (const registryKey of filesystemAgentIds) {
    validatePrimitiveIdentity(application, "agent", registryKey, registryKey, canonicalIds);
    catalog.push({
      applicationId: application.id,
      resourceType: "agent",
      resourceId: registryKey,
      ...application.access.agents[registryKey]!,
    });
  }
}

function mergePrimitives<T extends { id: string }>(
  application: AgentApplicationBundle,
  resourceType: "agent" | "workflow" | "scorer",
  primitives: Record<string, T>,
  access: Record<string, PrimitiveAccessPolicy>,
  target: Record<string, T>,
  canonicalIds: Map<string, string>,
  catalog: CatalogEntry[],
): void {
  validatePrimitiveAccessCoverage(application.id, resourceType, Object.keys(primitives), access);

  for (const [registryKey, primitive] of Object.entries(primitives)) {
    validatePrimitiveIdentity(application, resourceType, registryKey, primitive.id, canonicalIds);
    const policy = access[registryKey]!;
    target[registryKey] = primitive;
    catalog.push({ applicationId: application.id, resourceType, resourceId: registryKey, ...policy });
  }
}

function validatePrimitiveAccessCoverage(
  applicationId: string,
  resourceType: "agent" | "workflow" | "scorer",
  primitiveKeys: readonly string[],
  access: Record<string, PrimitiveAccessPolicy>,
): void {
  const uniquePrimitiveKeys = new Set(primitiveKeys);
  if (uniquePrimitiveKeys.size !== primitiveKeys.length) {
    const duplicates = primitiveKeys.filter((key, index) => primitiveKeys.indexOf(key) !== index);
    throw new Error(`${applicationId} ${resourceType} has duplicate registry keys: ${[...new Set(duplicates)].join(", ")}`);
  }
  const metadataKeys = Object.keys(access);
  const missing = primitiveKeys.filter(key => !access[key]);
  const orphaned = metadataKeys.filter(key => !uniquePrimitiveKeys.has(key));
  if (missing.length > 0) throw new Error(`${applicationId} ${resourceType} missing permission metadata: ${missing.join(", ")}`);
  if (orphaned.length > 0) throw new Error(`${applicationId} ${resourceType} permission metadata has no primitive: ${orphaned.join(", ")}`);
  for (const key of primitiveKeys) validatePolicy(`${applicationId} ${resourceType} ${key}`, access[key]!);
}

function validatePrimitiveIdentity(
  application: AgentApplicationBundle,
  resourceType: "agent" | "workflow" | "scorer",
  registryKey: string,
  primitiveId: string,
  canonicalIds: Map<string, string>,
): void {
  const expectedPrefix = `${application.id}-`;
  if (!registryKey.startsWith(expectedPrefix)) {
    throw new Error(`${application.id} ${resourceType} registry key "${registryKey}" must start with "${expectedPrefix}"`);
  }
  if (primitiveId !== registryKey) {
    throw new Error(`${application.id} ${resourceType} registry key "${registryKey}" must equal canonical id "${primitiveId}"`);
  }
  claimCanonicalId(primitiveId, `${application.id} ${resourceType}`, canonicalIds);
}

function validateMetadataCoverage(
  applicationId: string,
  resourceType: "channel" | "protocol",
  access: Record<string, PrimitiveAccessPolicy>,
  catalog: CatalogEntry[],
): void {
  for (const [resourceId, policy] of Object.entries(access)) {
    validatePolicy(`${applicationId} ${resourceType} ${resourceId}`, policy);
    catalog.push({
      applicationId,
      resourceType,
      resourceId: resourceType === "protocol" ? `${applicationId}:${resourceId}` : resourceId,
      ...policy,
    });
  }
}

function validatePolicy(label: string, policy: PrimitiveAccessPolicy): void {
  if (!policy.permission.trim()) throw new Error(`${label} has an empty permission`);
  if (policy.audiences.length === 0) throw new Error(`${label} has no allowed audience`);
  if (new Set(policy.audiences).size !== policy.audiences.length) throw new Error(`${label} has duplicate audiences`);
}

function claimCanonicalId(id: string, owner: string, ids: Map<string, string>): void {
  const existing = ids.get(id);
  if (existing) throw new Error(`Duplicate canonical id "${id}" owned by ${existing} and ${owner}`);
  ids.set(id, owner);
}
