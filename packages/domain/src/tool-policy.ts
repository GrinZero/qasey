import type { IntentRoute, QaseyChannel, ToolPolicy } from "../../contracts/src/index.ts";

export class ToolPolicyViolation extends Error {
  constructor(public readonly toolId: string, message: string) {
    super(message);
    this.name = "ToolPolicyViolation";
  }
}

export interface ToolCallAuthorization {
  channel: QaseyChannel;
  route: IntentRoute;
  approved?: boolean;
  subagentRole?: "orchestrator" | "evidence_researcher" | "code_author" | "verifier";
}

export function authorizeToolAccess(toolId: string, policy: ToolPolicy, auth: ToolCallAuthorization): void {
  if (!policy.allowedChannels.includes(auth.channel)) {
    throw new ToolPolicyViolation(toolId, `${toolId} is not available on ${auth.channel}`);
  }
  if (!policy.allowedIntents.includes(auth.route.intent)) {
    throw new ToolPolicyViolation(toolId, `${toolId} is not allowed for ${auth.route.intent}`);
  }
  if (auth.subagentRole === "evidence_researcher" && policy.effect !== "read") {
    throw new ToolPolicyViolation(toolId, "Evidence researcher is strictly read-only");
  }
  if (policy.effect === "delete") {
    throw new ToolPolicyViolation(toolId, "Delete tools are disabled for agents");
  }
}

export function authorizeToolCall(toolId: string, policy: ToolPolicy, auth: ToolCallAuthorization): void {
  authorizeToolAccess(toolId, policy, auth);
  if (policy.requiresApproval && !auth.approved) {
    throw new ToolPolicyViolation(toolId, `${toolId} requires explicit approval`);
  }
}

export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  metersphere_read: {
    effect: "read", allowedChannels: ["slack", "jira", "api"],
    allowedIntents: ["qa_quick_query", "qa_review", "case_create_full", "case_maintain_fast"], requiresApproval: false,
  },
  metersphere_write: {
    effect: "write", allowedChannels: ["slack", "jira", "api"],
    allowedIntents: ["case_create_full", "case_maintain_fast"], requiresApproval: false,
  },
  qa_experience_write: {
    effect: "write", allowedChannels: ["slack"], allowedIntents: ["experience_write"], requiresApproval: true,
  },
  external_read: {
    effect: "read", allowedChannels: ["slack", "jira", "api"],
    allowedIntents: ["qa_quick_query", "qa_review", "case_create_full", "case_maintain_fast", "experience_read", "experience_write", "meta_or_out_of_scope", "unknown", "e2e_generate", "e2e_rerun", "e2e_repair", "e2e_status"], requiresApproval: false,
  },
  slack_message: {
    effect: "message", allowedChannels: ["slack"],
    allowedIntents: ["qa_quick_query", "qa_review", "case_create_full", "case_maintain_fast", "experience_read", "experience_write", "meta_or_out_of_scope", "unknown", "e2e_generate", "e2e_rerun", "e2e_repair", "e2e_status"], requiresApproval: false,
  },
  jira_message: {
    effect: "message", allowedChannels: ["jira"],
    allowedIntents: ["qa_quick_query", "qa_review", "case_create_full", "case_maintain_fast", "experience_read", "meta_or_out_of_scope", "unknown", "e2e_generate", "e2e_rerun", "e2e_repair", "e2e_status"], requiresApproval: false,
  },
  git_write: {
    effect: "write", allowedChannels: ["slack", "jira", "api"], allowedIntents: ["e2e_generate", "e2e_repair"], requiresApproval: false,
  },
};
