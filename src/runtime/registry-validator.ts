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

    mergePrimitives(application, "agent", application.agents, application.access.agents, agents, canonicalIds, catalog);
    mergePrimitives(application, "workflow", application.workflows, application.access.workflows, workflows, canonicalIds, catalog);
    mergePrimitives(application, "scorer", application.scorers ?? {}, application.access.scorers ?? {}, scorers, canonicalIds, catalog);
    validateMetadataCoverage(application.id, "channel", application.access.channels ?? {}, catalog);

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

function mergePrimitives<T extends { id: string }>(
  application: AgentApplicationBundle,
  resourceType: "agent" | "workflow" | "scorer",
  primitives: Record<string, T>,
  access: Record<string, PrimitiveAccessPolicy>,
  target: Record<string, T>,
  canonicalIds: Map<string, string>,
  catalog: CatalogEntry[],
): void {
  const primitiveKeys = Object.keys(primitives);
  const metadataKeys = Object.keys(access);
  const missing = primitiveKeys.filter(key => !access[key]);
  const orphaned = metadataKeys.filter(key => !primitives[key]);
  if (missing.length > 0) throw new Error(`${application.id} ${resourceType} missing permission metadata: ${missing.join(", ")}`);
  if (orphaned.length > 0) throw new Error(`${application.id} ${resourceType} permission metadata has no primitive: ${orphaned.join(", ")}`);

  for (const [registryKey, primitive] of Object.entries(primitives)) {
    const expectedPrefix = `${application.id}-`;
    if (!registryKey.startsWith(expectedPrefix)) {
      throw new Error(`${application.id} ${resourceType} registry key "${registryKey}" must start with "${expectedPrefix}"`);
    }
    if (primitive.id !== registryKey) {
      throw new Error(`${application.id} ${resourceType} registry key "${registryKey}" must equal canonical id "${primitive.id}"`);
    }
    claimCanonicalId(primitive.id, `${application.id} ${resourceType}`, canonicalIds);
    const policy = access[registryKey]!;
    validatePolicy(`${application.id} ${resourceType} ${registryKey}`, policy);
    target[registryKey] = primitive;
    catalog.push({ applicationId: application.id, resourceType, resourceId: registryKey, ...policy });
  }
}

function validateMetadataCoverage(
  applicationId: string,
  resourceType: "channel",
  access: Record<string, PrimitiveAccessPolicy>,
  catalog: CatalogEntry[],
): void {
  for (const [resourceId, policy] of Object.entries(access)) {
    validatePolicy(`${applicationId} ${resourceType} ${resourceId}`, policy);
    catalog.push({ applicationId, resourceType, resourceId, ...policy });
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
