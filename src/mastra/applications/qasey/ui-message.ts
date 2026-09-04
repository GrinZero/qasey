import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type InferUIMessageChunk,
} from "ai";
import type {
  OwnerScope,
  QaseyConversationEvent,
  QaseyConversationTurn,
  QaseyProgressData,
  QaseyPublicToolInput,
  QaseyUIMessage,
  QaseyUIMessageMetadata,
} from "../../../../packages/contracts/src/index.ts";
import type { QaseyConversationRepository } from "../../../../packages/domain/src/conversation-repository.ts";

const pollIntervalMs = 250;

export function conversationTurnsToUIMessages(
  turns: QaseyConversationTurn[],
  eventsByTurn: ReadonlyMap<string, QaseyConversationEvent[]>,
): QaseyUIMessage[] {
  return turns.flatMap(turn => {
    const events = eventsByTurn.get(turn.id) ?? [];
    const latestSequence = events.reduce((latest, event) => Math.max(latest, event.sequence), 0);
    const metadata = messageMetadata(turn, latestSequence);
    const assistantParts: QaseyUIMessage["parts"] = [];
    const toolPartIndexes = new Map<string, number>();

    for (const event of events) {
      if (event.type === "progress") {
        assistantParts.push(progressPart(event));
      } else if (event.type === "tool.started") {
        const part = startedToolPart(event);
        if (part) {
          toolPartIndexes.set(part.toolCallId, assistantParts.length);
          assistantParts.push(part);
        }
      } else if (event.type === "tool.finished") {
        const toolCallId = stringPayload(event, "toolCallId");
        const index = toolCallId ? toolPartIndexes.get(toolCallId) : undefined;
        const current = index === undefined ? undefined : dynamicToolPart(assistantParts[index]);
        const part = finishedToolPart(event, current);
        if (part && index === undefined) {
          toolPartIndexes.set(part.toolCallId, assistantParts.length);
          assistantParts.push(part);
        } else if (part && index !== undefined) {
          assistantParts[index] = part;
        }
      } else if (event.type === "run.linked") {
        const runId = stringPayload(event, "runId");
        if (runId) assistantParts.push({ type: "data-run", id: `${turn.id}:run`, data: { runId } });
      } else if (event.type === "failed") {
        assistantParts.push(failurePart(event));
      }
    }
    if (turn.assistantText) assistantParts.push({ type: "text", text: turn.assistantText, state: "done" });
    if (latestSequence > 0) {
      assistantParts.push({ type: "data-cursor", id: `${turn.id}:cursor`, data: { sequence: latestSequence } });
    }

    return [
      {
        id: turn.clientMessageId,
        role: "user",
        metadata,
        parts: [{ type: "text", text: turn.userMessage }],
      },
      {
        id: turn.id,
        role: "assistant",
        metadata,
        parts: assistantParts,
      },
    ];
  });
}

export function conversationEventStreamResponse(input: {
  repository: QaseyConversationRepository;
  owner: OwnerScope;
  subjectId: string;
  conversationId: string;
  turn: QaseyConversationTurn;
  after?: number;
  signal: AbortSignal;
}): Response {
  let cursor = Math.max(0, input.after ?? 0);
  const stream = createUIMessageStream<QaseyUIMessage>({
    generateId: () => input.turn.id,
    execute: async ({ writer }) => {
      let textPartId: string | undefined;
      let emittedText = false;
      let linkedRunId = input.turn.linkedRunId;
      let terminalError: string | undefined;
      const emittedToolCalls = new Set<string>();
      writer.write({
        type: "start",
        messageId: input.turn.id,
        messageMetadata: messageMetadata(input.turn, cursor),
      });

      while (!input.signal.aborted) {
        const events = await input.repository.events(
          input.owner,
          input.subjectId,
          input.conversationId,
          input.turn.id,
          cursor,
        );
        for (const event of events) {
          cursor = event.sequence;
          if (event.type === "assistant.delta") {
            const text = stringPayload(event, "text");
            if (text) {
              textPartId ??= `${input.turn.id}:text:${Math.max(0, input.after ?? 0)}`;
              if (!emittedText) writer.write({ type: "text-start", id: textPartId });
              emittedText = true;
              writer.write({ type: "text-delta", id: textPartId, delta: text });
            }
          } else if (event.type === "progress") {
            writer.write(progressChunk(event));
          } else if (event.type === "tool.started") {
            const chunk = toolInputChunk(event);
            if (chunk) {
              emittedToolCalls.add(chunk.toolCallId);
              writer.write(chunk);
            }
          } else if (event.type === "tool.finished") {
            const inputChunk = toolInputChunk(event);
            if (inputChunk && !emittedToolCalls.has(inputChunk.toolCallId)) writer.write(inputChunk);
            if (inputChunk) emittedToolCalls.add(inputChunk.toolCallId);
            const outputChunk = toolOutputChunk(event);
            if (outputChunk) writer.write(outputChunk);
          } else if (event.type === "run.linked") {
            const runId = stringPayload(event, "runId");
            if (runId) {
              linkedRunId = runId;
              writer.write({ type: "data-run", id: `${input.turn.id}:run`, data: { runId } });
            }
          } else if (event.type === "failed") {
            writer.write(failureChunk(event));
            terminalError = stringPayload(event, "message") ?? "Qasey 未能完成这轮处理，请重试。";
          } else if (event.type === "completed" && !emittedText && (input.after ?? 0) === 0) {
            const text = stringPayload(event, "text");
            if (text) {
              textPartId = `${input.turn.id}:text:${Math.max(0, input.after ?? 0)}`;
              writer.write({ type: "text-start", id: textPartId });
              writer.write({ type: "text-delta", id: textPartId, delta: text });
              emittedText = true;
            }
          }

          writer.write({ type: "data-cursor", id: `${input.turn.id}:cursor`, data: { sequence: cursor } });
          writer.write({
            type: "message-metadata",
            messageMetadata: {
              ...messageMetadata(input.turn, cursor),
              ...(linkedRunId ? { linkedRunId } : {}),
            },
          });
        }

        const terminal = events.find(event => event.type === "completed" || event.type === "failed");
        if (terminal) {
          if (textPartId && emittedText) writer.write({ type: "text-end", id: textPartId });
          writer.write({
            type: "finish",
            finishReason: terminal.type === "completed" ? "stop" : "error",
            messageMetadata: {
              ...messageMetadata(input.turn, cursor),
              ...(linkedRunId ? { linkedRunId } : {}),
            },
          });
          writer.setOutcome(terminal.type === "completed"
            ? { status: "completed" }
            : { status: "failed", error: new Error("Qasey conversation turn failed") });
          if (terminalError) writer.write({ type: "error", errorText: terminalError });
          return;
        }
        await waitForPoll(input.signal);
      }
    },
    onError: () => "Qasey 实时响应暂时中断，请刷新后继续。",
  });

  return createUIMessageStreamResponse({
    stream,
    headers: {
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function messageMetadata(turn: QaseyConversationTurn, latestSequence: number): QaseyUIMessageMetadata {
  return {
    conversationId: turn.conversationId,
    turnId: turn.id,
    createdAt: turn.createdAt,
    latestSequence,
    ...(turn.linkedRunId ? { linkedRunId: turn.linkedRunId } : {}),
  };
}

function progressData(event: QaseyConversationEvent): QaseyProgressData {
  const rawStatus = stringPayload(event, "status");
  const status = rawStatus === "waiting" || rawStatus === "blocked" ? rawStatus : "working";
  return {
    sequence: event.sequence,
    title: stringPayload(event, "title") ?? "处理进度",
    detail: stringPayload(event, "detail") ?? "",
    status,
    ...(stringPayload(event, "milestone") ? { milestone: stringPayload(event, "milestone") } : {}),
    ...(stringPayload(event, "next") ? { next: stringPayload(event, "next") } : {}),
  };
}

function progressPart(event: QaseyConversationEvent): Extract<QaseyUIMessage["parts"][number], { type: "data-progress" }> {
  return { type: "data-progress", id: `${event.turnId}:progress:${event.sequence}`, data: progressData(event) };
}

function progressChunk(event: QaseyConversationEvent): InferUIMessageChunk<QaseyUIMessage> {
  return { type: "data-progress", id: `${event.turnId}:progress:${event.sequence}`, data: progressData(event) };
}

type QaseyDynamicToolPart = Extract<QaseyUIMessage["parts"][number], { type: "dynamic-tool" }>;

function startedToolPart(event: QaseyConversationEvent): QaseyDynamicToolPart | undefined {
  const data = toolEventData(event);
  if (!data) return undefined;
  return {
    type: "dynamic-tool",
    toolCallId: data.toolCallId,
    toolName: data.toolName,
    title: data.title,
    state: "input-available",
    input: data.input,
  };
}

function finishedToolPart(event: QaseyConversationEvent, current?: QaseyDynamicToolPart): QaseyDynamicToolPart | undefined {
  const data = toolEventData(event, current);
  if (!data) return undefined;
  if (booleanPayload(event, "isError")) {
    return {
      type: "dynamic-tool",
      toolCallId: data.toolCallId,
      toolName: data.toolName,
      title: data.title,
      state: "output-error",
      input: data.input,
      errorText: data.outputSummary,
    };
  }
  return {
    type: "dynamic-tool",
    toolCallId: data.toolCallId,
    toolName: data.toolName,
    title: data.title,
    state: "output-available",
    input: data.input,
    output: { summary: data.outputSummary },
  };
}

function toolInputChunk(event: QaseyConversationEvent): Extract<InferUIMessageChunk<QaseyUIMessage>, { type: "tool-input-available" }> | undefined {
  const data = toolEventData(event);
  if (!data) return undefined;
  return {
    type: "tool-input-available",
    toolCallId: data.toolCallId,
    toolName: data.toolName,
    title: data.title,
    input: data.input,
    dynamic: true,
  };
}

function toolOutputChunk(event: QaseyConversationEvent): Extract<InferUIMessageChunk<QaseyUIMessage>, { type: "tool-output-available" | "tool-output-error" }> | undefined {
  const data = toolEventData(event);
  if (!data) return undefined;
  return booleanPayload(event, "isError")
    ? { type: "tool-output-error", toolCallId: data.toolCallId, errorText: data.outputSummary, dynamic: true }
    : { type: "tool-output-available", toolCallId: data.toolCallId, output: { summary: data.outputSummary }, dynamic: true };
}

function toolEventData(event: QaseyConversationEvent, current?: QaseyDynamicToolPart): {
  toolCallId: string;
  toolName: string;
  title: string;
  input: QaseyPublicToolInput;
  outputSummary: string;
} | undefined {
  const toolCallId = stringPayload(event, "toolCallId") ?? current?.toolCallId;
  const toolName = stringPayload(event, "toolName") ?? current?.toolName;
  if (!toolCallId || !toolName) return undefined;
  const currentInput = current && typeof current.input === "object" && current.input !== null
    && typeof (current.input as { summary?: unknown }).summary === "string"
    ? (current.input as { summary: string }).summary
    : undefined;
  return {
    toolCallId,
    toolName,
    title: stringPayload(event, "title") ?? current?.title ?? "执行内部工具",
    input: { summary: stringPayload(event, "inputSummary") ?? currentInput ?? "正在执行内部工具…" },
    outputSummary: stringPayload(event, "outputSummary") ?? "工具执行完成。",
  };
}

function dynamicToolPart(part: QaseyUIMessage["parts"][number] | undefined): QaseyDynamicToolPart | undefined {
  return part?.type === "dynamic-tool" ? part : undefined;
}

function failureData(event: QaseyConversationEvent): QaseyProgressData {
  return {
    sequence: event.sequence,
    title: "处理失败",
    detail: stringPayload(event, "message") ?? "这轮处理失败，请重新发送。",
    status: "failed",
  };
}

function failurePart(event: QaseyConversationEvent): Extract<QaseyUIMessage["parts"][number], { type: "data-progress" }> {
  return { type: "data-progress", id: `${event.turnId}:failure`, data: failureData(event) };
}

function failureChunk(event: QaseyConversationEvent): InferUIMessageChunk<QaseyUIMessage> {
  return { type: "data-progress", id: `${event.turnId}:failure`, data: failureData(event) };
}

function stringPayload(event: QaseyConversationEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" && value ? value : undefined;
}

function booleanPayload(event: QaseyConversationEvent, key: string): boolean {
  return event.payload[key] === true;
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, pollIntervalMs);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
