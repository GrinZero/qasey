import type { QaseyUIMessage, QaseyConversationTurn, QaseyConversationEvent } from "../../../../packages/contracts/src/index.ts";
import type { CollaborationState } from "../../../../packages/domain/src/collaboration-repository.ts";
import { conversationTurnsToUIMessages } from "./ui-message.ts";

export function collaborationUIMessages(state: CollaborationState, turns: QaseyConversationTurn[], events: ReadonlyMap<string, QaseyConversationEvent[]>, conversationId: string): QaseyUIMessage[] {
  const legacy = conversationTurnsToUIMessages(turns, events);
  const claimed = new Set(state.messages.flatMap(m => m.turnId ? [m.turnId] : []));
  const messages = legacy.filter(m => !claimed.has(m.metadata?.turnId ?? ""));
  for (const message of state.messages) {
    const base = message.turnId ? legacy.find(m => m.id === message.turnId && m.role === "assistant") : undefined;
    const parts: QaseyUIMessage["parts"] = [...(base?.parts.filter(p => p.type !== "text") ?? [])];
    for (const tool of message.toolCalls ?? []) {
      const common = { type: "dynamic-tool" as const, toolCallId: tool.id, toolName: tool.name, title: tool.title, input: { summary: tool.title } };
      parts.push(tool.status === "running" ? { ...common, state: "input-available" }
        : tool.status === "failed" ? { ...common, state: "output-error", errorText: "执行失败，查看运行详情了解原因。" }
        : { ...common, state: "output-available", output: { summary: "执行完成。" } });
    }
    const text = message.text || (base?.parts.filter(p => p.type === "text").map(p => p.text).join("") ?? "");
    messages.push({
      id: message.id, role: message.role,
      metadata: {
        ...base?.metadata,
        conversationId,
        turnId: message.turnId ?? (message.rootMessageId.match(/^[\da-f-]{36}$/i) ? message.rootMessageId : "00000000-0000-4000-8000-000000000000"),
        createdAt: message.createdAt, latestSequence: state.revision,
        authorAgentId: message.authorAgentId, recipientAgentIds: message.recipientAgentIds,
        collaborationStatus: message.status, messageKind: message.kind,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.runId ? { linkedRunId: message.runId } : {}),
      },
      parts: [...parts, ...(text ? [{ type: "text" as const, text, state: message.status === "running" ? "streaming" as const : "done" as const }] : [])],
    });
  }
  return messages.sort((a, b) => (a.metadata?.createdAt ?? "").localeCompare(b.metadata?.createdAt ?? ""));
}
