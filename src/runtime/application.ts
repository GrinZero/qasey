import type { Agent } from "@mastra/core/agent";
import type { MastraScorer } from "@mastra/core/evals";
import type { ApiRoute } from "@mastra/core/server";
import type { AnyWorkflow } from "@mastra/core/workflows";

export type RuntimeAudience = "admin-ui" | "api" | "service" | "channel";

export interface PrimitiveAccessPolicy {
  permission: string;
  audiences: readonly RuntimeAudience[];
}

export interface OwnedApiRoute {
  id: string;
  route: ApiRoute;
  access: PrimitiveAccessPolicy;
  /** Public routes are limited to probes and OAuth protocol endpoints. */
  public?: boolean;
}

/** Product-facing metadata used by the shared Agent Platform shell. */
export interface ApplicationUiManifest {
  name: string;
  description: string;
  category: string;
  capabilities: readonly string[];
  homePath: string;
  accent: "indigo" | "teal" | "amber" | "coral" | "blue";
}

/**
 * Composition-time ownership bundle. It deliberately has no execute/dispatch
 * method: callers use Mastra's native Agent and Workflow handlers.
 */
export interface AgentApplicationBundle {
  id: string;
  ui?: ApplicationUiManifest;
  agents: Record<string, Agent<any, any, any, any, any>>;
  workflows: Record<string, AnyWorkflow>;
  scorers?: Record<string, MastraScorer<any, any, any, any>>;
  access: {
    agents: Record<string, PrimitiveAccessPolicy>;
    workflows: Record<string, PrimitiveAccessPolicy>;
    scorers?: Record<string, PrimitiveAccessPolicy>;
    channels?: Record<string, PrimitiveAccessPolicy>;
  };
  routes?: readonly OwnedApiRoute[];
}

export interface CatalogEntry extends PrimitiveAccessPolicy {
  applicationId: string;
  resourceType: "agent" | "workflow" | "scorer" | "channel" | "route";
  resourceId: string;
  routePath?: string;
  routeMethod?: string;
  /** Public custom routes bypass principal resolution; primitives are never public. */
  public?: boolean;
}
