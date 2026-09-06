import type { MastraLanguageModel } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import type { Workspace } from "@mastra/core/workspace";

export interface E2ECandidateValidationResult {
  passed: boolean;
  summary: string;
  changedPaths: string[];
}

export interface E2EAuthorRuntimeBindings {
  model: MastraLanguageModel;
  workspace: Workspace;
  profileId: "web-e2e-author" | "web-e2e-repair";
  writablePaths: string[];
  requiredSkillPath?: string;
  requiredSkillInstructions?: string;
  validateCandidate: () => Promise<E2ECandidateValidationResult>;
  validation: {
    calls: number;
    lastResult?: E2ECandidateValidationResult;
  };
}

const bindings = new WeakMap<RequestContext<any>, E2EAuthorRuntimeBindings>();

export function isE2EAuthorStudioRequest(requestContext: { get(key: string): unknown }): boolean {
  return requestContext.get("ingressSource") === "mastra-studio";
}

export function bindE2EAuthorRuntime(
  requestContext: RequestContext<any>,
  value: E2EAuthorRuntimeBindings,
): () => void {
  if (bindings.has(requestContext)) throw new Error("E2E author RequestContext is already bound");
  bindings.set(requestContext, value);
  return () => bindings.delete(requestContext);
}

export function resolveE2EAuthorRuntime(
  requestContext: RequestContext<any>,
): E2EAuthorRuntimeBindings | undefined {
  return bindings.get(requestContext);
}

export function requireE2EAuthorRuntime(requestContext: RequestContext<any>): E2EAuthorRuntimeBindings {
  const value = resolveE2EAuthorRuntime(requestContext);
  if (!value) {
    throw new Error("qasey-e2e-author is internal to an isolated E2E CodeTask and cannot run without runtime bindings");
  }
  return value;
}
