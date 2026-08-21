import type { QaseyAgentRuntimeEvent } from "./service.ts";

export interface SlackReactionTarget {
  addReaction(emoji: string): Promise<void>;
  removeReaction(emoji: string): Promise<void>;
}

export interface SlackStatusTarget {
  startTyping(status?: string): Promise<void>;
}

const WORKING_REACTION = "👀";
const STATUS_MAX_CHARS = 100;
const SENSITIVE_KEY = /(?:^|_)(?:access_?token|api_?key|authorization|cookie|credential|password|private_?key|secret|session)(?:$|_)/i;
const SENSITIVE_VALUE = /\b(?:Bearer\s+[A-Za-z0-9._~+\/-]+=*|xox[a-z]-[A-Za-z0-9-]+)\b/gi;
const INLINE_SECRET = /\b(?:access[_-]?token|api[_-]?key|authorization|cookie|password|private[_-]?key|secret|session)\s*[:=]\s*["']?[^\s,;"']+/gi;
const IMPORTANT_KEYS = [
  "title", "summary", "message", "name", "key", "issueKey", "issue_key", "repository", "repo", "owner",
  "pullNumber", "pull_number", "number", "path", "url", "query", "project", "module", "status", "success",
  "count", "total", "item_count", "changedFiles", "changed_files", "additions", "deletions",
];

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
  private lastEvidence: string | undefined;

  project(event: QaseyAgentRuntimeEvent): string | undefined {
    if (event.type === "step-start") {
      const input = summarizeMessages(event.inputMessages);
      const subject = input || this.lastEvidence;
      return subject ? statusLine(`第 ${event.step} 步 · ${subject}`) : undefined;
    }

    if (event.type === "tool-call") {
      this.calls.set(event.toolCallId, { toolName: event.toolName, ...(event.args !== undefined ? { args: event.args } : {}) });
      const target = summarizeValue(event.args);
      return statusLine(`正在执行 ${toolLabel(event.toolName)}${target ? ` · ${target}` : ""}`);
    }

    if (event.type === "tool-result") {
      const call = this.calls.get(event.toolCallId);
      this.calls.delete(event.toolCallId);
      const result = summarizeValue(event.result);
      const target = summarizeValue(event.args ?? call?.args);
      const evidence = result || target;
      if (evidence) this.lastEvidence = evidence;
      const label = toolLabel(event.toolName || call?.toolName || "tool");
      return statusLine(`${label}${event.isError ? " 执行失败" : " 返回"}${evidence ? ` · ${evidence}` : ""}`);
    }

    const conclusion = summarizeText(event.text);
    if (conclusion) {
      this.lastEvidence = conclusion;
      return statusLine(conclusion);
    }
    const tools = [...new Set(event.toolCalls.map(call => toolLabel(call.toolName)))];
    if (tools.length > 0) {
      const detail = this.lastEvidence ? ` · ${this.lastEvidence}` : "";
      return statusLine(`已完成 ${tools.join("、")}${detail}`);
    }
    return this.lastEvidence ? statusLine(this.lastEvidence) : undefined;
  }
}

function summarizeMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return summarizeValue(messages);
  const last = messages.at(-1);
  if (isRecord(last) && last.content !== undefined) {
    const content = Array.isArray(last.content) ? textFromContentParts(last.content) : undefined;
    return content ? summarizeText(content) : summarizeValue(last.content);
  }
  return summarizeValue(last);
}

function summarizeValue(value: unknown, depth = 0): string | undefined {
  if (value === undefined || value === null || depth > 3) return undefined;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed === undefined ? summarizeText(value) : summarizeValue(parsed, depth + 1);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "0 项";
    const primitives = value.filter(item => ["string", "number", "boolean"].includes(typeof item)).slice(0, 3);
    if (primitives.length > 0) {
      const preview = primitives.map(item => summarizeValue(item, depth + 1)).filter(Boolean).join("、");
      return statusLine(`${value.length} 项${preview ? `：${preview}` : ""}`);
    }
    const last = summarizeValue(value.at(-1), depth + 1);
    return statusLine(`${value.length} 项${last ? ` · ${last}` : ""}`);
  }
  if (!isRecord(value)) return undefined;

  const contentText = extractContentText(value);
  if (contentText) return summarizeValue(contentText, depth + 1);
  if (value.content !== undefined && Object.keys(value).length <= 4) return summarizeValue(value.content, depth + 1);

  const entries = Object.entries(value).filter(([key, item]) => !SENSITIVE_KEY.test(key) && item !== undefined && item !== null);
  const rank = (key: string) => {
    const index = IMPORTANT_KEYS.indexOf(key);
    return index === -1 ? IMPORTANT_KEYS.length : index;
  };
  entries.sort(([left], [right]) => rank(left) - rank(right));
  const facts: string[] = [];
  for (const [key, item] of entries) {
    if (facts.length >= 3) break;
    const label = humanizeKey(key);
    if (Array.isArray(item)) {
      facts.push(`${label}=${item.length} 项`);
      continue;
    }
    if (isRecord(item)) {
      const nested = summarizeValue(item, depth + 1);
      if (nested) facts.push(`${label}=${nested}`);
      continue;
    }
    const rendered = summarizeValue(item, depth + 1);
    if (rendered) facts.push(`${label}=${rendered}`);
  }
  return facts.length > 0 ? statusLine(facts.join(" · ")) : undefined;
}

function extractContentText(value: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value.content)) return undefined;
  return textFromContentParts(value.content);
}

function textFromContentParts(content: unknown[]): string | undefined {
  const textParts = content.flatMap(part => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return [];
    return [part.text];
  });
  return textParts.length > 0 ? textParts.join(" ") : undefined;
}

function summarizeText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutUrlSecrets = value.replace(/https?:\/\/[^\s)]+/gi, raw => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return raw.split(/[?#]/, 1)[0] ?? raw;
    }
  });
  const text = withoutUrlSecrets
    .replace(SENSITIVE_VALUE, "[已隐藏]")
    .replace(INLINE_SECRET, "[已隐藏]")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_~`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? statusLine(text) : undefined;
}

function toolLabel(toolName: string): string {
  const words = toolName.replace(/^qasey_/, "").split(/[_./:-]+/).filter(Boolean);
  if (words.length === 0) return "tool";
  const source = words[0]!;
  const action = words.slice(1);
  const sourceLabel = source.toLowerCase() === "github" ? "GitHub"
    : source.toLowerCase() === "jira" ? "Jira"
      : source.toLowerCase() === "figma" ? "Figma"
        : source.toLowerCase() === "slack" ? "Slack"
          : source.toLowerCase() === "metersphere" ? "MeterSphere"
            : source;
  return action.length > 0 ? `${sourceLabel} ${action.join(" ")}` : sourceLabel;
}

function humanizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
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
  const chars = [...value.trim()];
  return chars.length <= STATUS_MAX_CHARS ? chars.join("") : `${chars.slice(0, STATUS_MAX_CHARS - 1).join("")}…`;
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
