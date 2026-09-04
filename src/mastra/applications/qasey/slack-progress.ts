import type { QaseyAgentRuntimeEvent } from "./service.ts";

export interface SlackReactionTarget {
  addReaction(emoji: string): Promise<void>;
  removeReaction(emoji: string): Promise<void>;
}

export interface SlackStatusTarget {
  startTyping(status?: string): Promise<void>;
}

const WORKING_REACTION = "👀";
// Slack validates both `status` and each `loading_messages` entry at <= 50 characters.
const STATUS_MAX_CHARS = 50;
const SENSITIVE_KEY = /(?:^|_)(?:token|access_?token|api_?key|authorization|cookie|credential|password|private_?key|secret|session)(?:$|_)/i;
const SENSITIVE_VALUE = /\b(?:Bearer\s+[A-Za-z0-9._~+\/-]+=*|xox[a-z]-[A-Za-z0-9-]+)\b/gi;
const INLINE_SECRET = /\b(?:token|access[_-]?token|api[_-]?key|authorization|cookie|password|private[_-]?key|secret|session)\s*[:=]\s*["']?[^\s,;"']+/gi;
const INTERNAL_TEXT = /(?:System prompt|系统提示|已识别的\s*intent|<INSTRUCTIONS>|工具调用约束)/iu;
const SKILL_LABELS: Record<string, string> = {
  "qa-experience": "QA 历史经验规范",
  "qa-quick-query": "QA 快速查询规范",
  "qa-review": "QA 评审规范",
  "e2e-lifecycle": "E2E 执行规范",
  "git-repository-workspace": "Git 仓库工作区规范",
};

const HIDDEN_CHAT_TOOL_NAMES = new Set(["get_current_time", "qasey_report_progress"]);

export interface QaseyPublicToolPresentation {
  toolName: string;
  title: string;
  summary: string;
}

/**
 * Produce the deliberately small, secret-free projection persisted in Qasey
 * chat history. Raw tool input never crosses this boundary.
 */
export function publicToolCallPresentation(toolName: string, args: unknown): QaseyPublicToolPresentation | undefined {
  if (HIDDEN_CHAT_TOOL_NAMES.has(toolName)) return undefined;
  return {
    toolName,
    title: publicToolTitle(toolName),
    summary: renderToolCall(toolName, args) ?? "正在执行内部工具…",
  };
}

/** Raw tool output and errors are reduced to a bounded business summary. */
export function publicToolResultPresentation(
  toolName: string,
  result: unknown,
  args: unknown,
  isError: boolean,
): QaseyPublicToolPresentation | undefined {
  if (HIDDEN_CHAT_TOOL_NAMES.has(toolName)) return undefined;
  return {
    toolName,
    title: publicToolTitle(toolName),
    summary: renderToolResult(toolName, result, args, isError) ?? defaultToolResultSummary(toolName, isError),
  };
}

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

/**
 * Projects the live Agent event stream into one concise Slack status. The
 * status is derived from event payloads, not from Qasey's deterministic
 * business phases. Raw reasoning and secret-looking fields are never used.
 */
export class SlackAgentStatusProjector {
  private readonly calls = new Map<string, { toolName: string; args?: unknown }>();
  private started = false;
  private taskTopic: string | undefined;

  project(event: QaseyAgentRuntimeEvent): string | undefined {
    if (event.type === "step-start") {
      if (this.started) return undefined;
      this.started = true;
      this.taskTopic = inferTopic(lastUserMessageText(event.inputMessages));
      return statusLine(this.taskTopic
        ? `正在理解 ${this.taskTopic} 的测试需求…`
        : "正在理解你的测试需求…");
    }

    if (event.type === "tool-call") {
      this.calls.set(event.toolCallId, { toolName: event.toolName, ...(event.args !== undefined ? { args: event.args } : {}) });
      return renderToolCall(event.toolName, event.args, this.taskTopic);
    }

    if (event.type === "tool-result") {
      const call = this.calls.get(event.toolCallId);
      this.calls.delete(event.toolCallId);
      return renderToolResult(
        event.toolName || call?.toolName || "tool",
        event.result,
        event.args ?? call?.args,
        event.isError,
        this.taskTopic,
      );
    }

    const conclusion = publicStatusText(event.text);
    return conclusion ? statusLine(conclusion) : undefined;
  }
}

function renderToolCall(toolName: string, args: unknown, taskTopic?: string): string | undefined {
  const input = asRecord(args);
  if (toolName === "skill") {
    const name = stringField(input, "name", "skillName", "skill_name");
    return statusLine(`正在加载${friendlySkillName(name)}…`);
  }
  if (toolName === "search_tools") {
    const topic = inferTopic(stringField(input, "query")) || taskTopic || "当前任务";
    return statusLine(`正在查找${topic}相关能力…`);
  }
  if (toolName === "qasey_report_progress") return progressStatus(input);
  if (toolName === "get_current_time") return undefined;
  if (toolName === "execute_typescript") return "正在并行核对相关资料…";

  if (toolName === "mastra_workspace_execute_command" && isRepositoryReadCommand(input)) {
    return repositoryCommandStatus(input, taskTopic);
  }

  if (toolName.startsWith("github_")) {
    const repo = stringField(input, "repo", "repository") || "相关仓库";
    const pullNumber = numberField(input, "pullNumber", "pull_number", "number");
    if (toolName.includes("pull_request_diff")) return statusLine(`正在查看 ${repo}${prLabel(pullNumber)} 的代码改动…`);
    if (toolName.includes("review")) return statusLine(`正在查看 ${repo}${prLabel(pullNumber)} 的评审意见…`);
    if (toolName.includes("pull_request")) return statusLine(`正在查看 ${repo}${prLabel(pullNumber)} 的 PR 信息…`);
    if (toolName.includes("get_file")) {
      const path = stringField(input, "path");
      return statusLine(`正在查看 ${repo}${path ? ` 的 ${fileName(path)}` : " 的相关实现"}…`);
    }
    const topic = inferTopic(stringField(input, "query")) || taskTopic || "当前需求";
    return statusLine(`正在查找与${topic}相关的代码仓库…`);
  }

  if (toolName.startsWith("jira_")) {
    const issueKey = stringField(input, "issueKey", "issue_key", "key");
    if (toolName.includes("get_issue")) return statusLine(`正在查看 ${issueKey || "相关 Jira 需求"} 的需求与验收范围…`);
    const topic = inferTopic(stringField(input, "jql", "query")) || taskTopic || "当前需求";
    return statusLine(`正在查找${topic}相关需求…`);
  }

  if (toolName.startsWith("slack_")) {
    const topic = inferTopic(stringField(input, "query")) || taskTopic;
    if (toolName.includes("search_messages")) return statusLine(topic ? `正在搜索与${topic}相关的讨论…` : "正在搜索相关 Slack 讨论…");
    if (toolName.includes("get_user")) return "正在查找相关成员信息…";
    if (toolName.includes("get_file")) return "正在读取 Slack 中的附件…";
    return "正在查看相关 Slack 讨论…";
  }

  if (toolName.startsWith("figma_")) {
    const topic = inferTopic(stringField(input, "title", "name", "query")) || taskTopic;
    if (toolName.includes("comments")) return statusLine(topic ? `正在查看${topic}设计稿的评论…` : "正在查看设计稿评论…");
    return statusLine(topic ? `正在查看${topic}的设计稿…` : "正在查看相关设计稿…");
  }

  if (toolName.startsWith("lark_")) {
    const topic = inferTopic(stringField(input, "title", "name", "query")) || taskTopic;
    if (toolName.includes("search")) return statusLine(topic ? `正在查找${topic}相关文档…` : "正在查找相关飞书文档…");
    return statusLine(topic ? `正在阅读${topic}技术方案…` : "正在阅读相关飞书文档…");
  }

  if (/^(?:qaExperience_|qa_context_|qa_experience_)/.test(toolName)) {
    const topic = inferTopic(stringField(input, "query", "topic", "title")) || taskTopic || "当前需求";
    return statusLine(`正在查找${topic}的历史测试经验…`);
  }

  if (toolName.startsWith("rag_") || toolName === "answer") {
    const topic = inferTopic(stringField(input, "query", "question")) || taskTopic || "当前需求";
    return statusLine(`正在检索${topic}相关资料…`);
  }

  if (toolName.startsWith("case_hub_")) {
    if (toolName.includes("create_change_set")) return "正在冻结候选用例并启动 E2E 验证…";
    return "正在读取 Case Hub 用例与审核状态…";
  }

  if (toolName.startsWith("e2e_")) {
    if (toolName.includes("create")) return "正在准备新的 E2E 验证…";
    if (toolName.includes("rerun")) return "正在重新运行 E2E 验证…";
    return "正在查看 E2E 运行结果…";
  }

  return statusLine(taskTopic ? `正在核对${taskTopic}的相关资料…` : "正在核对相关资料…");
}

function publicToolTitle(toolName: string): string {
  if (toolName === "skill") return "加载任务规范";
  if (toolName === "search_tools") return "查找可用工具";
  if (toolName === "execute_typescript") return "并行核对资料";
  if (toolName === "mastra_workspace_execute_command") return "检查代码工作区";
  if (toolName.startsWith("github_")) return "读取 GitHub";
  if (toolName.startsWith("jira_")) return "读取 Jira 需求";
  if (toolName.startsWith("slack_")) return "检索 Slack 讨论";
  if (toolName.startsWith("figma_")) return "读取 Figma 设计";
  if (toolName.startsWith("lark_")) return "读取飞书文档";
  if (/^(?:qaExperience_|qa_context_|qa_experience_)/.test(toolName)) return "检索 QA 历史经验";
  if (toolName.startsWith("rag_") || toolName === "answer") return "检索知识库";
  if (toolName === "case_hub_search_cases") return "查询已有用例";
  if (toolName === "case_hub_create_change_set") return "启动测试执行";
  if (toolName.startsWith("case_hub_")) return "读取 Case Hub";
  if (toolName.startsWith("e2e_")) return "检查 E2E 运行";
  return "执行内部工具";
}

function defaultToolResultSummary(toolName: string, isError: boolean): string {
  if (isError) return "工具执行失败，Qasey 正在调整处理方式。";
  if (toolName === "skill") return "任务规范已加载。";
  if (toolName === "execute_typescript") return "并行资料核对完成。";
  return "工具执行完成。";
}

function renderToolResult(
  toolName: string,
  rawResult: unknown,
  args: unknown,
  isError: boolean,
  taskTopic?: string,
): string | undefined {
  if ((toolName === "skill" && !isError) || toolName === "qasey_report_progress" || toolName === "get_current_time") return undefined;
  const input = asRecord(args);
  const result = unwrapResult(rawResult);
  if (isError) return renderToolFailure(toolName, input);

  if (toolName === "search_tools") {
    const count = resultCount(result);
    const topic = inferTopic(stringField(input, "query")) || taskTopic || "当前任务";
    return count === undefined
      ? statusLine(`已准备好${topic}相关工具…`)
      : statusLine(`已准备好 ${count} 个${topic}相关工具…`);
  }

  if (toolName === "mastra_workspace_execute_command" && isRepositoryReadCommand(input)) {
    return "已完成本地 Git/GitHub 查询，正在分析代码与改动…";
  }

  if (toolName.startsWith("github_")) {
    const repo = stringField(input, "repo", "repository") || "相关仓库";
    const pullNumber = numberField(input, "pullNumber", "pull_number", "number");
    if (toolName.includes("pull_request_diff")) {
      const changedFiles = numberIn(result, "changedFiles", "changed_files") ?? arrayLengthIn(result, "files");
      return statusLine(changedFiles === undefined
        ? `已读取 ${repo}${prLabel(pullNumber)}，正在分析测试影响…`
        : `已读取 PR${prLabel(pullNumber)}，发现 ${changedFiles} 个文件变更…`);
    }
    if (toolName.includes("list_reviews")) {
      const count = resultCount(result);
      return statusLine(count === undefined ? "已读取 PR 评审意见…" : `已找到 ${count} 条 PR 评审意见…`);
    }
    if (toolName.includes("get_file")) {
      const path = stringField(input, "path");
      return statusLine(`已读取${path ? ` ${fileName(path)}` : "相关代码"}，正在分析相关实现…`);
    }
    return statusLine(`已读取 ${repo}${prLabel(pullNumber)}，正在核对需求影响…`);
  }

  if (toolName.startsWith("jira_")) {
    const issueKey = stringField(input, "issueKey", "issue_key", "key");
    if (toolName.includes("get_issue")) return statusLine(`已读取 ${issueKey || "Jira 需求"}，正在核对验收范围…`);
    const count = resultCount(result);
    return statusLine(count === undefined ? "已读取相关 Jira 需求…" : `已找到 ${count} 条相关 Jira 需求…`);
  }

  if (toolName.startsWith("slack_")) {
    const count = resultCount(result);
    return statusLine(count === undefined
      ? "已读取相关讨论，正在核对上下文…"
      : `已找到 ${count} 条相关讨论，正在提取结论…`);
  }

  if (toolName.startsWith("figma_")) return "已读取相关设计稿，正在核对交互与状态…";
  if (toolName.startsWith("lark_")) return "已读取技术方案，正在提取业务规则…";

  if (/^(?:qaExperience_|qa_context_|qa_experience_)/.test(toolName)) {
    const count = resultCount(result);
    return statusLine(count === undefined ? "已读取历史测试经验，正在判断适用性…" : `已找到 ${count} 条历史经验，正在判断适用性…`);
  }

  if (toolName.startsWith("rag_") || toolName === "answer") return "已检索相关资料，正在核对证据…";
  if (toolName.startsWith("case_hub_")) {
    if (toolName.includes("create_change_set")) return "Change Set 已创建，正在隔离环境中生成和验证 Playwright…";
    return "已读取 Case Hub 用例与审核状态…";
  }

  if (toolName.startsWith("e2e_")) {
    if (toolName.includes("create") || toolName.includes("rerun")) return "E2E 运行已启动，正在等待验证结果…";
    return "已读取 E2E 运行结果，正在核对证据…";
  }

  if (toolName === "execute_typescript") return undefined;
  const summary = publicStatusText(stringIn(result, "summary", "message", "title"));
  return summary ? statusLine(summary) : undefined;
}

function renderToolFailure(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "skill") return "暂时无法加载任务规范，正在调整处理方式…";
  if (toolName === "search_tools") return "暂时无法查找相关能力，正在调整处理方式…";
  if (toolName === "mastra_workspace_execute_command" && isRepositoryReadCommand(input)) {
    return "本地 Git/GitHub 查询暂时失败，正在调整检索方式…";
  }
  if (toolName.startsWith("jira_")) {
    const issue = stringField(input, "issueKey", "issue_key", "key") || "Jira 需求";
    return statusLine(`暂时无法读取 ${issue}，正在重新判断下一步…`);
  }
  if (toolName.startsWith("github_")) {
    const repo = stringField(input, "repo", "repository") || "GitHub 内容";
    const pullNumber = numberField(input, "pullNumber", "pull_number", "number");
    return statusLine(`暂时无法读取 ${repo}${prLabel(pullNumber)}，正在调整处理方式…`);
  }
  if (toolName.startsWith("figma_")) return "暂时无法读取设计稿，正在调整处理方式…";
  if (toolName.startsWith("lark_")) return "暂时无法读取飞书文档，正在调整处理方式…";
  if (toolName.startsWith("slack_")) return "暂时无法读取 Slack 讨论，正在调整处理方式…";
  if (toolName.startsWith("case_hub_")) return "暂时无法访问 Case Hub，正在核对 Change Set 状态…";
  return "当前资料读取失败，正在重新判断下一步…";
}

function progressStatus(input: Record<string, unknown>): string | undefined {
  const title = publicStatusText(stringField(input, "title"));
  const next = publicStatusText(stringField(input, "next"));
  if (!title) return next ? statusLine(`正在${stripActionPrefix(next)}…`) : undefined;
  if (!next) return statusLine(`${stripTerminalPunctuation(title)}…`);
  return statusLine(`${stripTerminalPunctuation(title)}，正在${stripActionPrefix(next)}…`);
}

function friendlySkillName(name?: string): string {
  if (!name) return "相关任务规范";
  return SKILL_LABELS[name] ?? `${name.replace(/[-_]+/g, " ")} 规范`;
}

function repositoryCommandStatus(input: Record<string, unknown>, taskTopic?: string): string {
  const command = commandText(input);
  if (/\bgh\s+(?:pr|api)\b/iu.test(command)) {
    const pullNumber = command.match(/(?:\bpr\s+(?:view|diff|checks)\s+|\/pulls\/)(\d+)\b/iu)?.[1];
    return statusLine(`正在核对 GitHub${pullNumber ? ` PR #${pullNumber}` : " PR"} 与相关代码…`);
  }
  if (/\b(?:rg|grep)\b/iu.test(command)) {
    return statusLine(`正在搜索${taskTopic ? `${taskTopic}相关` : "仓库中的"}实现…`);
  }
  return "正在读取本地 Git 工作区与改动历史…";
}

function isRepositoryReadCommand(input: Record<string, unknown>): boolean {
  const command = commandText(input);
  if (!command) return false;
  if (/\b(?:push|commit|merge|rebase|reset|checkout|switch|branch\s+-[dD]|clean\s+-f)\b/iu.test(command)) return false;
  return /(?:^|[\s;&|])(?:gh|git|rg|grep)(?:\s|$)/iu.test(command);
}

function commandText(input: Record<string, unknown>): string {
  const values: string[] = [];
  for (const key of ["command", "cmd", "args"] as const) {
    const value = input[key];
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === "string"));
  }
  return values.join(" ");
}

function lastUserMessageText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    return contentText(message.content);
  }
  return undefined;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return sanitizeText(content);
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap(part => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []);
  return texts.length > 0 ? sanitizeText(texts.join(" ")) : undefined;
}

function inferTopic(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = sanitizeText(value).replace(/https?:\/\/\S+/giu, " ");
  const known = [...text.matchAll(/\b(?:Case Hub|GitHub|Jira|Slack|Figma|Pre-auth|Split Payment|E2E|Playwright)\b/giu)].at(-1)?.[0];
  if (known) return known;
  const issue = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/u)?.[0];
  if (issue) return issue;
  const quoted = text.match(/[「“"]([^」”"]{2,28})[」”"]/u)?.[1];
  if (quoted) return truncateStatus(quoted, 24);
  const cleaned = text
    .replace(/<@[A-Z0-9]+>/giu, " ")
    .replace(/(?:帮我|请|根据|分析|查看|写一下|写一份|这个需求|测试用例|\bcase\b)/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? truncateStatus(cleaned, 24) : undefined;
}

function publicStatusText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = sanitizeText(value);
  if (!text || INTERNAL_TEXT.test(text) || text.startsWith("{") || text.startsWith("[")) return undefined;
  return text;
}

function sanitizeText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/giu, raw => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch {
        return raw.split(/[?#]/, 1)[0] ?? raw;
      }
    })
    .replace(SENSITIVE_VALUE, "[已隐藏]")
    .replace(INLINE_SECRET, "[已隐藏]")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_~`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapResult(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === "string") {
    const parsed = parseJsonOrModelOutput(value);
    return parsed === undefined ? value : unwrapResult(parsed, depth + 1);
  }
  if (!isRecord(value)) return value;
  if (value.data !== undefined) return unwrapResult(value.data, depth + 1);
  if (value.type === "text" && typeof value.value === "string") return unwrapResult(value.value, depth + 1);
  if (Array.isArray(value.content)) {
    const text = value.content.flatMap(part => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join(" ");
    if (text) return unwrapResult(text, depth + 1);
  }
  return value;
}

function parseJsonOrModelOutput(value: string): unknown | undefined {
  const direct = parseJson(value);
  if (direct !== undefined) return direct;
  const newline = value.indexOf("\n");
  return newline >= 0 ? parseJson(value.slice(newline + 1).trim()) : undefined;
}

function resultCount(value: unknown): number | undefined {
  const direct = numberIn(value, "total", "count", "item_count", "itemCount", "total_count", "totalCount");
  if (direct !== undefined) return direct;
  return arrayLengthIn(value, "items", "list_items", "results", "values", "issues", "messages", "files", "creates", "updates")
    ?? (Array.isArray(value) ? value.length : undefined);
}

function numberIn(value: unknown, ...keys: string[]): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = numberIn(item, ...keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const direct = numberField(value, ...keys);
  if (direct !== undefined) return direct;
  for (const item of Object.values(value)) {
    if (isRecord(item) || Array.isArray(item)) {
      const found = numberIn(item, ...keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function arrayLengthIn(value: unknown, ...keys: string[]): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) if (Array.isArray(value[key])) return value[key].length;
  for (const item of Object.values(value)) {
    if (!isRecord(item)) continue;
    const found = arrayLengthIn(item, ...keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function stringIn(value: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(value)) return typeof value === "string" ? value : undefined;
  return stringField(value, ...keys);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() && !SENSITIVE_KEY.test(key)) return sanitizeText(candidate);
  }
  return undefined;
}

function numberField(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key] as number;
  return undefined;
}

function prLabel(pullNumber?: number): string {
  return pullNumber === undefined ? "" : ` #${pullNumber}`;
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || "相关实现";
}

function stripActionPrefix(value: string): string {
  return stripTerminalPunctuation(value).replace(/^(?:正在|继续|接下来|下一步[:：]?)/u, "").trim();
}

function stripTerminalPunctuation(value: string): string {
  return value.replace(/[。！!；;，,、…]+$/u, "").trim();
}

function parseJson(value: string): unknown | undefined {
  const text = value.trim();
  if (!(text.startsWith("{") && text.endsWith("}")) && !(text.startsWith("[") && text.endsWith("]"))) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function statusLine(value: string): string {
  return truncateStatus(value, STATUS_MAX_CHARS);
}

function truncateStatus(value: string, maxChars: number): string {
  const chars = [...value.trim()];
  if (chars.length <= maxChars) return chars.join("");
  if (maxChars <= 1) return "…".slice(0, maxChars);
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ignoreReactionFailure(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Slack reactions are best-effort feedback; delivery continues without them.
  }
}
