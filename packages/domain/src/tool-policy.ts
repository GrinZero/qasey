import type { QaseyChannel, ToolPolicy } from "../../contracts/src/index.ts";

export class ToolPolicyViolation extends Error {
  constructor(public readonly toolId: string, message: string) {
    super(message);
    this.name = "ToolPolicyViolation";
  }
}

export interface ToolDiscoveryAuthorization {
  channel: QaseyChannel;
  subagentRole?: "orchestrator" | "evidence_researcher" | "code_author" | "verifier";
}

/**
 * Hard authorization for Agent-discovered tools. Semantic intent is
 * deliberately absent: discovery controls relevance, while channel, effect,
 * approval and workflow ownership remain runtime policy.
 */
export function authorizeDiscoveredToolAccess(
  toolId: string,
  policy: ToolPolicy,
  auth: ToolDiscoveryAuthorization,
): void {
  if (!policy.allowedChannels.includes(auth.channel)) {
    throw new ToolPolicyViolation(toolId, `${toolId} is not available on ${auth.channel}`);
  }
  if (auth.subagentRole === "evidence_researcher" && policy.effect !== "read") {
    throw new ToolPolicyViolation(toolId, "Evidence researcher is strictly read-only");
  }
  if (policy.effect === "delete") {
    throw new ToolPolicyViolation(toolId, "Delete tools are disabled for agents");
  }
}

export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  case_hub_read: {
    effect: "read", allowedChannels: ["slack", "jira", "api"],
    requiresApproval: false,
  },
  case_hub_change_set_write: {
    effect: "write", allowedChannels: ["slack", "jira", "api"],
    requiresApproval: false,
  },
  qa_experience_write: {
    effect: "write", allowedChannels: ["slack"], requiresApproval: true,
  },
  external_read: {
    effect: "read", allowedChannels: ["slack", "jira", "api"],
    requiresApproval: false,
  },
  slack_message: {
    effect: "message", allowedChannels: ["slack"],
    requiresApproval: false,
  },
  jira_message: {
    effect: "message", allowedChannels: ["jira"],
    requiresApproval: false,
  },
  git_write: {
    effect: "write", allowedChannels: ["slack", "jira", "api"], requiresApproval: false,
  },
};
