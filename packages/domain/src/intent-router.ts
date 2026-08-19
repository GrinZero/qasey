import type { Intent, IntentRoute } from "../../contracts/src/index.ts";
import { IntentRouteSchema } from "../../contracts/src/index.ts";

const writeTargets: Record<Intent, IntentRoute["writeTarget"]> = {
  qa_quick_query: "none",
  qa_review: "none",
  case_create_full: "metersphere",
  case_maintain_fast: "metersphere",
  experience_read: "none",
  experience_write: "qa_experience",
  meta_or_out_of_scope: "none",
  unknown: "none",
  e2e_generate: "git",
  e2e_rerun: "none",
  e2e_repair: "git",
  e2e_status: "none",
};

export function sanitizeIntentRoute(candidate: unknown): IntentRoute {
  const parsed = IntentRouteSchema.safeParse(candidate);
  if (!parsed.success) return fallbackIntentRoute("Intent router returned invalid structured output");
  const route = parsed.data;
  return {
    ...route,
    writeTarget: writeTargets[route.intent],
    reason: route.reason.slice(0, 500),
  };
}

export function fallbackIntentRoute(reason: string): IntentRoute {
  return {
    version: 2,
    intent: "unknown",
    relation: "unknown",
    writeTarget: "none",
    depth: "quick",
    confidence: 0,
    reason: reason.slice(0, 500),
    routerStatus: "fallback",
  };
}
