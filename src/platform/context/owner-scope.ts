import type { RequestContext } from "@mastra/core/request-context";
import { OwnerScopeSchema, type OwnerScope } from "../../../packages/contracts/src/index.ts";

export function ownerScopeFromRequestContext(requestContext: RequestContext<any>): OwnerScope {
  const identity = requestContext.get("identity");
  const tenantId = identity && typeof identity === "object" && "tenantId" in identity
    ? (identity as { tenantId?: unknown }).tenantId
    : undefined;
  return OwnerScopeSchema.parse({
    applicationId: requestContext.get("applicationId"),
    tenantId,
  });
}
