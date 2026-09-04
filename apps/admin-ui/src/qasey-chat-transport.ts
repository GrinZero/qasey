import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from "ai";
import type { QaseyUIMessage } from "./types";

export interface QaseyReconnectTarget {
  turnId: string;
  after: number;
  message?: QaseyUIMessage;
}

export class QaseyChatTransport extends DefaultChatTransport<QaseyUIMessage> {
  private readonly reconnectTarget: () => QaseyReconnectTarget | undefined;

  constructor(conversationId: string, reconnectTarget: () => QaseyReconnectTarget | undefined) {
    const conversationApi = `/v1/qasey/conversations/${encodeURIComponent(conversationId)}`;
    super({
      api: `${conversationApi}/messages`,
      prepareSendMessagesRequest: ({ messages }) => {
        const latest = findLatestUserMessage(messages);
        if (!latest) throw new Error("没有可发送的用户消息。");
        const message = latest.parts
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map(part => part.text)
          .join("");
        return { body: { message, clientMessageId: latest.id } };
      },
      prepareReconnectToStreamRequest: () => {
        const target = reconnectTarget();
        if (!target) return { api: `${conversationApi}/stream-unavailable` };
        return {
          api: `${conversationApi}/turns/${encodeURIComponent(target.turnId)}/events?after=${target.after}`,
        };
      },
    });
    this.reconnectTarget = reconnectTarget;
  }

  override async reconnectToStream(
    options: Parameters<DefaultChatTransport<QaseyUIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const resumed = await super.reconnectToStream(options);
    if (!resumed) return null;
    const message = this.reconnectTarget()?.message;
    if (!message) return resumed;
    const prefix = existingMessageChunks(message);
    return concatenateStreams(prefix, resumed);
  }
}

function findLatestUserMessage(messages: UIMessage[]): UIMessage | undefined {
  return messages.findLast(message => message.role === "user");
}

function existingMessageChunks(message: QaseyUIMessage): ReadableStream<UIMessageChunk> {
  const chunks: UIMessageChunk[] = [{ type: "start", messageId: message.id, messageMetadata: message.metadata }];
  message.parts.forEach((part, index) => {
    if (part.type === "text" && part.text) {
      const id = `${message.id}:restored-text:${index}`;
      chunks.push({ type: "text-start", id }, { type: "text-delta", id, delta: part.text }, { type: "text-end", id });
    } else if (part.type === "dynamic-tool" && part.input !== undefined) {
      chunks.push({
        type: "tool-input-available",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        dynamic: true,
        ...(part.title ? { title: part.title } : {}),
      });
      if (part.state === "output-available") {
        chunks.push({ type: "tool-output-available", toolCallId: part.toolCallId, output: part.output, dynamic: true });
      } else if (part.state === "output-error") {
        chunks.push({ type: "tool-output-error", toolCallId: part.toolCallId, errorText: part.errorText, dynamic: true });
      }
    } else if (part.type === "data-progress" || part.type === "data-run" || part.type === "data-cursor") {
      chunks.push(part);
    }
  });
  return new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(chunk));
      controller.close();
    },
  });
}

function concatenateStreams<T>(first: ReadableStream<T>, second: ReadableStream<T>): ReadableStream<T> {
  const streams = [first, second];
  let current = 0;
  let reader = streams[current]?.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      while (reader) {
        const next = await reader.read();
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        reader.releaseLock();
        current += 1;
        reader = streams[current]?.getReader();
      }
      controller.close();
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}
