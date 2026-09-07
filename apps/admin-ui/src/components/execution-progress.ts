import type { QaseyUIMessage } from "../types";

/** Keep a run at its first position while new events update its one progress block. */
export function groupExecutionMessages(messages: QaseyUIMessage[]): Map<string, QaseyUIMessage[]> {
  const groups = new Map<string, QaseyUIMessage[]>();
  for (const message of messages) {
    if (message.role !== "assistant" || (message.metadata?.messageKind !== "execution" && !message.id.startsWith("analysis:"))) continue;
    const key = message.metadata?.linkedRunId ?? message.id;
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }
  return groups;
}

export function executionHeadline(message: QaseyUIMessage | undefined): string {
  const text = message?.parts.filter(part => part.type === "text").map(part => part.text).join("") ?? "";
  // Historical messages can include logs and attachment links after the status.
  return text.split(/[。\n]/u)[0]?.slice(0, 80) || "等待执行进度";
}
