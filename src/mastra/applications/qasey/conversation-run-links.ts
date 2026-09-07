import type { E2ERun, OwnerScope } from "../../../../packages/contracts/src/index.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only successful run-creating tools may attach persisted runs to a conversation. */
export async function conversationRunFromToolResult(input: {
  toolName: string;
  result: unknown;
  args?: unknown;
  isError?: boolean;
  owner: OwnerScope;
  conversationId: string;
  repository: { get(owner: OwnerScope, id: string): Promise<E2ERun | undefined> };
}): Promise<string | undefined> {
  if (input.isError) return undefined;
  const result = record(input.result);
  if (!result || result.error || result.success === false) return undefined;
  let candidate: Record<string, unknown> | undefined;
  switch (input.toolName) {
    case "case_hub_start_e2e":
    case "caseHubStartE2E":
      candidate = record(result.run);
      break;
    case "case_hub_rerun_results":
    case "caseHubRerunResults":
      candidate = result;
      break;
    case "update_e2e_execution":
    case "updateE2eExecution":
      if (record(input.args)?.action !== "amend") return undefined;
      candidate = record(result.run) ?? record(record(result.result)?.run);
      break;
    default:
      return undefined;
  }
  if (typeof candidate?.id !== "string" || !candidate.id.trim()) return undefined;
  // Never trust ownership or sourceSessionId supplied in a tool-result payload.
  const run = await input.repository.get(input.owner, candidate.id);
  if (!run || run.id !== candidate.id || run.applicationId !== input.owner.applicationId
    || run.tenantId !== input.owner.tenantId || run.sourceSessionId !== input.conversationId) return undefined;
  return run.id;
}
