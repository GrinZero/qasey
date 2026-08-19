import { RequestContext } from "@mastra/core/request-context";
import type { PlatformRequestContextValues } from "./schema.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY, PlatformRequestContextSchema } from "./schema.ts";

export function createTrustedRequestContext(values: PlatformRequestContextValues): RequestContext {
  const parsed = PlatformRequestContextSchema.parse(values);
  const context = new RequestContext();
  for (const [key, value] of Object.entries(parsed)) context.set(key, value);
  context.set(MASTRA_RESOURCE_ID_KEY, parsed[MASTRA_RESOURCE_ID_KEY]);
  context.set(MASTRA_THREAD_ID_KEY, parsed[MASTRA_THREAD_ID_KEY]);
  return context;
}

/** Trusted values always win; request-controlled values are never copied. */
export function applyTrustedContext(target: RequestContext, values: PlatformRequestContextValues): RequestContext {
  const trusted = createTrustedRequestContext(values);
  for (const key of Object.keys(PlatformRequestContextSchema.shape)) target.set(key, trusted.get(key));
  return target;
}

