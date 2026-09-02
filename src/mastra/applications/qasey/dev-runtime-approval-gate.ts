import { createHash } from "node:crypto";
import type { ToolsInput } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";

export const DEV_RUNTIME_APPROVAL_GATE_KEY = "qasey-dev-runtime-approval-gate";

export interface DevRuntimeApprovalRequest {
  toolName: string;
  argsSummary: string;
  argsHash: string;
}

export interface DevRuntimeApprovalGate {
  request(input: DevRuntimeApprovalRequest): Promise<"approved" | "declined">;
}

export class DevRuntimeApprovalDeclinedError extends Error {
  readonly code = "DEV_RUNTIME_APPROVAL_DECLINED";

  constructor(toolName: string) {
    super(`Slack user declined local tool execution: ${toolName}`);
    this.name = "DevRuntimeApprovalDeclinedError";
  }
}

/** Replace native suspension only for a locally-tunnelled request. */
export function applyDevRuntimeApprovalGate<TTools extends ToolsInput>(
  tools: TTools,
  requestContext?: RequestContext<any>,
): TTools {
  const gate = requestContext?.get(DEV_RUNTIME_APPROVAL_GATE_KEY) as DevRuntimeApprovalGate | undefined;
  if (!gate) return tools;
  return Object.fromEntries(Object.entries(tools).map(([toolName, tool]) => {
    if (!tool || typeof tool !== "object" || !("requireApproval" in tool) || tool.requireApproval !== true) {
      return [toolName, tool];
    }
    const execute = "execute" in tool && typeof tool.execute === "function" ? tool.execute : undefined;
    return [toolName, {
      ...tool,
      requireApproval: false,
      execute: async (input: unknown, executionContext: unknown) => {
        const serialized = safeRedactedJson(input);
        const decision = await gate.request({
          toolName,
          argsSummary: serialized.slice(0, 1_200),
          argsHash: createHash("sha256").update(serialized).digest("hex"),
        });
        if (decision !== "approved") throw new DevRuntimeApprovalDeclinedError(toolName);
        if (!execute) throw new Error(`Approval-gated tool ${toolName} has no executor`);
        return execute(input as never, executionContext as never);
      },
    } as ToolsInput[string]];
  })) as TTools;
}

function safeRedactedJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (key, entry) => {
      if (/token|secret|password|authorization|cookie/iu.test(key)) return "[REDACTED]";
      if (entry && typeof entry === "object") {
        if (seen.has(entry)) return "[Circular]";
        seen.add(entry);
      }
      if (typeof entry === "string" && entry.length > 500) return `${entry.slice(0, 500)}…`;
      return entry;
    }) ?? String(value);
  } catch {
    return "[Unserializable tool input]";
  }
}
