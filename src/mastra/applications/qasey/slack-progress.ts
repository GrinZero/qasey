export interface SlackReactionTarget {
  addReaction(emoji: string): Promise<void>;
  removeReaction(emoji: string): Promise<void>;
}

export interface SlackStatusTarget {
  startTyping(status?: string): Promise<void>;
}

export type QaseyPhase = "routing" | "agent" | "workflow" | "finalizing";

const WORKING_REACTION = "👀";

/**
 * A reaction acknowledges the request without turning an internal runtime
 * phase into a low-information thread reply. Reaction failures are cosmetic
 * and must never fail the user's task.
 */
export async function markSlackRequestStarted(target: SlackReactionTarget): Promise<void> {
  await ignoreReactionFailure(() => target.addReaction(WORKING_REACTION));
}

/** Replace the transient acknowledgement with the delivered outcome. */
export async function markSlackRequestFinished(
  target: SlackReactionTarget,
  outcome: "success" | "failure",
): Promise<void> {
  await ignoreReactionFailure(() => target.removeReaction(WORKING_REACTION));
  await ignoreReactionFailure(() => target.addReaction(outcome === "success" ? "✅" : "⚠️"));
}

/**
 * Keep long work visible in Slack's transient assistant status. Unlike
 * thread.post(), this does not create a reply or pollute conversation history.
 */
export async function showSlackStatus(target: SlackStatusTarget, status: string | undefined): Promise<void> {
  if (!status) return;
  await ignoreReactionFailure(() => target.startTyping(status));
}

export function slackPhaseStatus(phase: QaseyPhase): string {
  if (phase === "routing") return "正在理解需求…";
  if (phase === "agent") return "正在收集并核对相关资料…";
  if (phase === "workflow") return "正在写入并回查 MeterSphere…";
  return "正在整理结果…";
}

export function slackToolStatus(toolName: string): string | undefined {
  const name = toolName.toLowerCase();
  if (name === "qasey_report_progress") return undefined;
  if (name.includes("metersphere")) {
    if (/upsert|create|edit|write/.test(name)) return "正在准备 MeterSphere 用例变更…";
    return "正在核对 MeterSphere 模块和用例…";
  }
  if (name.includes("github") || /pull.?request|repository|repo_/.test(name)) return "正在核对 PR 和代码变更…";
  if (name.includes("jira")) return "正在核对 Jira 需求与讨论…";
  if (name.includes("figma")) return "正在核对设计稿…";
  if (name.includes("lark")) return "正在核对飞书文档…";
  if (name.includes("slack")) return "正在核对 Slack 讨论…";
  if (name.includes("experience") || name.includes("qa_context")) return "正在核对 QA 规范与历史经验…";
  if (name.includes("rag") || name.includes("answer")) return "正在检索相关资料…";
  if (name.includes("e2e") || name.includes("run")) return "正在核对自动化运行…";
  return "正在核对相关证据…";
}

async function ignoreReactionFailure(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Slack reactions are best-effort feedback; delivery continues without them.
  }
}
