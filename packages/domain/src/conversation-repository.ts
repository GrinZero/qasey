import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  QaseyConversationEventSchema,
  QaseyConversationSchema,
  QaseyConversationTurnSchema,
  type OwnerScope,
  type QaseyConversation,
  type QaseyConversationEvent,
  type QaseyConversationEventType,
  type QaseyConversationTurn,
} from "../../contracts/src/index.ts";

type ConversationEventType = QaseyConversationEventType;

export class ConversationBusyError extends Error {
  readonly code = "conversation_busy";
  constructor(readonly conversationId: string) {
    super(`Qasey conversation ${conversationId} already has an active turn`);
  }
}

export class ConversationTurnClosedError extends Error {
  readonly code = "conversation_turn_closed";
  constructor(readonly turnId: string) {
    super(`Qasey conversation turn ${turnId} is already terminal`);
  }
}

export interface StartedConversationTurn {
  turn: QaseyConversationTurn;
  accepted: QaseyConversationEvent;
  created: boolean;
}

export interface QaseyConversationRepository {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  createConversation(owner: OwnerScope, subjectId: string): Promise<QaseyConversation>;
  listConversations(owner: OwnerScope, subjectId: string, limit?: number): Promise<QaseyConversation[]>;
  getConversation(owner: OwnerScope, subjectId: string, id: string): Promise<QaseyConversation | undefined>;
  listTurns(owner: OwnerScope, subjectId: string, conversationId: string): Promise<QaseyConversationTurn[]>;
  startTurn(owner: OwnerScope, subjectId: string, conversationId: string, clientMessageId: string, message: string): Promise<StartedConversationTurn>;
  appendEvent(owner: OwnerScope, subjectId: string, conversationId: string, turnId: string, type: ConversationEventType, payload?: Record<string, unknown>): Promise<QaseyConversationEvent>;
  events(owner: OwnerScope, subjectId: string, conversationId: string, turnId: string, after?: number): Promise<QaseyConversationEvent[]>;
  failStale(before: Date): Promise<number>;
  close?(): Promise<void>;
}

export class InMemoryQaseyConversationRepository implements QaseyConversationRepository {
  private readonly conversations = new Map<string, QaseyConversation>();
  private readonly turns = new Map<string, QaseyConversationTurn>();
  private readonly turnEvents = new Map<string, QaseyConversationEvent[]>();

  constructor(private readonly now: () => Date = () => new Date()) {}
  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async createConversation(owner: OwnerScope, subjectId: string): Promise<QaseyConversation> {
    const now = this.now().toISOString();
    const conversation = QaseyConversationSchema.parse({
      ...owner, id: randomUUID(), subjectId, title: "新 QA 任务", createdAt: now, updatedAt: now,
    });
    this.conversations.set(ownerKey(owner, conversation.id), conversation);
    return structuredClone(conversation);
  }

  async listConversations(owner: OwnerScope, subjectId: string, limit = 50): Promise<QaseyConversation[]> {
    return [...this.conversations.entries()]
      .filter(([key, value]) => key.startsWith(ownerPrefix(owner)) && value.subjectId === subjectId)
      .map(([, value]) => structuredClone(value))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedLimit(limit));
  }

  async getConversation(owner: OwnerScope, subjectId: string, id: string): Promise<QaseyConversation | undefined> {
    const value = this.conversations.get(ownerKey(owner, id));
    return value?.subjectId === subjectId ? structuredClone(value) : undefined;
  }

  async listTurns(owner: OwnerScope, subjectId: string, conversationId: string): Promise<QaseyConversationTurn[]> {
    if (!await this.getConversation(owner, subjectId, conversationId)) return [];
    return [...this.turns.entries()]
      .filter(([key, value]) => key.startsWith(ownerPrefix(owner)) && value.conversationId === conversationId)
      .map(([, value]) => structuredClone(value))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async startTurn(owner: OwnerScope, subjectId: string, conversationId: string, clientMessageId: string, message: string): Promise<StartedConversationTurn> {
    const conversationKey = ownerKey(owner, conversationId);
    const conversation = this.conversations.get(conversationKey);
    if (!conversation || conversation.subjectId !== subjectId) throw new Error("Qasey conversation not found");
    const existing = [...this.turns.values()].find(turn =>
      turn.applicationId === owner.applicationId && turn.tenantId === owner.tenantId
      && turn.conversationId === conversationId && turn.clientMessageId === clientMessageId,
    );
    if (existing) {
      const accepted = this.turnEvents.get(ownerKey(owner, existing.id))?.[0];
      if (!accepted) throw new Error("Conversation turn is missing its accepted event");
      return { turn: structuredClone(existing), accepted: structuredClone(accepted), created: false };
    }
    if (conversation.activeTurnId) throw new ConversationBusyError(conversationId);
    const now = this.now().toISOString();
    const turn = QaseyConversationTurnSchema.parse({
      ...owner, id: randomUUID(), conversationId, clientMessageId, userMessage: message,
      status: "running", createdAt: now, updatedAt: now,
    });
    const accepted = QaseyConversationEventSchema.parse({
      ...owner, conversationId, turnId: turn.id, sequence: 1, type: "accepted",
      payload: { message }, occurredAt: now,
    });
    this.turns.set(ownerKey(owner, turn.id), turn);
    this.turnEvents.set(ownerKey(owner, turn.id), [accepted]);
    this.conversations.set(conversationKey, QaseyConversationSchema.parse({
      ...conversation, activeTurnId: turn.id,
      title: conversation.title === "新 QA 任务" ? conversationTitle(message) : conversation.title,
      updatedAt: now,
    }));
    return { turn: structuredClone(turn), accepted: structuredClone(accepted), created: true };
  }

  async appendEvent(owner: OwnerScope, subjectId: string, conversationId: string, turnId: string, type: ConversationEventType, payload: Record<string, unknown> = {}): Promise<QaseyConversationEvent> {
    const conversationKey = ownerKey(owner, conversationId);
    const conversation = this.conversations.get(conversationKey);
    const turnKey = ownerKey(owner, turnId);
    const turn = this.turns.get(turnKey);
    if (!conversation || conversation.subjectId !== subjectId || !turn || turn.conversationId !== conversationId) throw new Error("Qasey conversation turn not found");
    if (turn.status !== "running") throw new ConversationTurnClosedError(turnId);
    const events = this.turnEvents.get(turnKey) ?? [];
    const now = this.now().toISOString();
    const event = QaseyConversationEventSchema.parse({
      ...owner, conversationId, turnId, sequence: events.length + 1, type, payload, occurredAt: now,
    });
    const assistantText = type === "completed" && typeof payload.text === "string"
      ? payload.text
      : type === "assistant.delta" && typeof payload.text === "string"
        ? `${turn.assistantText}${payload.text}`
        : turn.assistantText;
    const status = type === "completed" ? "completed" : type === "failed" ? "failed" : turn.status;
    const linkedRunId = type === "run.linked" && typeof payload.runId === "string" ? payload.runId : turn.linkedRunId;
    const agentRunId = type === "completed" && typeof payload.runId === "string" ? payload.runId : turn.agentRunId;
    this.turnEvents.set(turnKey, [...events, event]);
    this.turns.set(turnKey, QaseyConversationTurnSchema.parse({
      ...turn, assistantText, status, ...(agentRunId ? { agentRunId } : {}), ...(linkedRunId ? { linkedRunId } : {}),
      ...(type === "failed" && typeof payload.message === "string" ? { error: payload.message } : {}),
      updatedAt: now,
    }));
    this.conversations.set(conversationKey, QaseyConversationSchema.parse({
      ...conversation, ...(status === "running" ? {} : { activeTurnId: undefined }), updatedAt: now,
    }));
    return structuredClone(event);
  }

  async events(owner: OwnerScope, subjectId: string, conversationId: string, turnId: string, after = 0): Promise<QaseyConversationEvent[]> {
    const conversation = await this.getConversation(owner, subjectId, conversationId);
    const turn = this.turns.get(ownerKey(owner, turnId));
    if (!conversation || !turn || turn.conversationId !== conversationId) return [];
    return structuredClone((this.turnEvents.get(ownerKey(owner, turnId)) ?? []).filter(event => event.sequence > after));
  }

  async failStale(before: Date): Promise<number> {
    let count = 0;
    for (const turn of [...this.turns.values()]) {
      if (turn.status !== "running" || new Date(turn.updatedAt) >= before) continue;
      const conversation = this.conversations.get(ownerKey(turn, turn.conversationId));
      if (!conversation || conversation.activeTurnId !== turn.id) continue;
      try {
        await this.appendEvent(
          { applicationId: turn.applicationId, tenantId: turn.tenantId },
          conversation.subjectId,
          turn.conversationId,
          turn.id,
          "failed",
          { message: "服务重启或执行超时，请重试这条消息。" },
        );
        count += 1;
      } catch (error) {
        if (!(error instanceof ConversationTurnClosedError)) throw error;
      }
    }
    return count;
  }

  async close(): Promise<void> {}
}

export class PrismaQaseyConversationRepository implements QaseyConversationRepository {
  private initialized?: Promise<void>;
  private readonly appendTails = new Map<string, Promise<void>>();
  constructor(private readonly prisma: PrismaClient, private readonly now: () => Date = () => new Date()) {}
  init(): Promise<void> { this.initialized ??= this.prisma.$connect(); return this.initialized; }
  private ready(): Promise<void> { return this.initialized ?? Promise.reject(new Error("PrismaQaseyConversationRepository has not been initialized")); }
  async healthCheck(): Promise<void> { await this.ready(); await this.prisma.$queryRaw`SELECT 1`; }

  async createConversation(owner: OwnerScope, subjectId: string): Promise<QaseyConversation> {
    await this.ready();
    const now = this.now();
    const conversation = QaseyConversationSchema.parse({ ...owner, id: randomUUID(), subjectId, title: "新 QA 任务", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    await this.prisma.qaseyConversationRecord.create({ data: {
      ...owner, id: conversation.id, subjectId, title: conversation.title, createdAt: now, updatedAt: now,
    } });
    return conversation;
  }

  async listConversations(owner: OwnerScope, subjectId: string, limit = 50): Promise<QaseyConversation[]> {
    await this.ready();
    const rows = await this.prisma.qaseyConversationRecord.findMany({
      where: { ...owner, subjectId }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: boundedLimit(limit),
    });
    return rows.map(conversationFromRow);
  }

  async getConversation(owner: OwnerScope, subjectId: string, id: string): Promise<QaseyConversation | undefined> {
    await this.ready();
    const row = await this.prisma.qaseyConversationRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id } } });
    return row?.subjectId === subjectId ? conversationFromRow(row) : undefined;
  }

  async listTurns(owner: OwnerScope, subjectId: string, conversationId: string): Promise<QaseyConversationTurn[]> {
    if (!await this.getConversation(owner, subjectId, conversationId)) return [];
    const rows = await this.prisma.qaseyConversationTurnRecord.findMany({
      where: { ...owner, conversationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(turnFromRow);
  }

  async startTurn(owner: OwnerScope, subjectId: string, conversationId: string, clientMessageId: string, message: string): Promise<StartedConversationTurn> {
    await this.ready();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async transaction => {
          const conversation = await transaction.qaseyConversationRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: conversationId } } });
          if (!conversation || conversation.subjectId !== subjectId) throw new Error("Qasey conversation not found");
          const existing = await transaction.qaseyConversationTurnRecord.findUnique({
            where: { applicationId_tenantId_conversationId_clientMessageId: { ...owner, conversationId, clientMessageId } },
          });
          if (existing) {
            const acceptedRow = await transaction.qaseyConversationEventRecord.findUnique({
              where: { applicationId_tenantId_turnId_sequence: { ...owner, turnId: existing.id, sequence: 1 } },
            });
            if (!acceptedRow) throw new Error("Conversation turn is missing its accepted event");
            return { turn: turnFromRow(existing), accepted: eventFromRow(acceptedRow), created: false };
          }
          if (conversation.activeTurnId) throw new ConversationBusyError(conversationId);
          const now = this.now();
          const turn = QaseyConversationTurnSchema.parse({
            ...owner, id: randomUUID(), conversationId, clientMessageId, userMessage: message,
            status: "running", createdAt: now.toISOString(), updatedAt: now.toISOString(),
          });
          const accepted = QaseyConversationEventSchema.parse({
            ...owner, conversationId, turnId: turn.id, sequence: 1, type: "accepted", payload: { message }, occurredAt: now.toISOString(),
          });
          await transaction.qaseyConversationTurnRecord.create({ data: {
            ...owner, id: turn.id, conversationId, clientMessageId, userMessage: message,
            assistantText: "", status: "running", eventSequence: 1, createdAt: now, updatedAt: now,
          } });
          await transaction.qaseyConversationEventRecord.create({ data: {
            ...owner, turnId: turn.id, conversationId, sequence: 1, type: accepted.type,
            payload: accepted.payload as Prisma.InputJsonValue, occurredAt: now,
          } });
          await transaction.qaseyConversationRecord.update({
            where: { applicationId_tenantId_id: { ...owner, id: conversationId } },
            data: {
              activeTurnId: turn.id,
              ...(conversation.title === "新 QA 任务" ? { title: conversationTitle(message) } : {}),
              updatedAt: now,
            },
          });
          return { turn, accepted, created: true };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (prismaErrorCode(error) === "P2034" && attempt < 2) continue;
        if (prismaErrorCode(error) === "P2002") {
          const existing = await this.prisma.qaseyConversationTurnRecord.findUnique({
            where: { applicationId_tenantId_conversationId_clientMessageId: { ...owner, conversationId, clientMessageId } },
          });
          if (existing) {
            const acceptedRow = await this.prisma.qaseyConversationEventRecord.findUnique({
              where: { applicationId_tenantId_turnId_sequence: { ...owner, turnId: existing.id, sequence: 1 } },
            });
            if (acceptedRow) return { turn: turnFromRow(existing), accepted: eventFromRow(acceptedRow), created: false };
          }
        }
        throw error;
      }
    }
    throw new ConversationBusyError(conversationId);
  }

  async appendEvent(owner: OwnerScope, subjectId: string, conversationId: string, turnId: string, type: ConversationEventType, payload: Record<string, unknown> = {}): Promise<QaseyConversationEvent> {
    await this.ready();
    return this.withAppendLock(ownerKey(owner, turnId), async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await this.prisma.$transaction(async transaction => {
          const conversation = await transaction.qaseyConversationRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: conversationId } } });
          const turn = await transaction.qaseyConversationTurnRecord.findUnique({ where: { applicationId_tenantId_id: { ...owner, id: turnId } } });
          if (!conversation || conversation.subjectId !== subjectId || !turn || turn.conversationId !== conversationId) throw new Error("Qasey conversation turn not found");
          if (turn.status !== "running") throw new ConversationTurnClosedError(turnId);
          const now = this.now();
          const sequence = turn.eventSequence + 1;
          const event = QaseyConversationEventSchema.parse({ ...owner, conversationId, turnId, sequence, type, payload, occurredAt: now.toISOString() });
          const delta = type === "assistant.delta" && typeof payload.text === "string" ? payload.text : "";
          const completedText = type === "completed" && typeof payload.text === "string" ? payload.text : undefined;
          const status = type === "completed" ? "completed" : type === "failed" ? "failed" : turn.status;
          await transaction.qaseyConversationTurnRecord.update({
            where: { applicationId_tenantId_id: { ...owner, id: turnId } },
            data: {
              eventSequence: sequence,
              ...(completedText !== undefined ? { assistantText: completedText } : delta ? { assistantText: `${turn.assistantText}${delta}` } : {}),
              ...(type === "completed" && typeof payload.runId === "string" ? { agentRunId: payload.runId } : {}),
              ...(type === "run.linked" && typeof payload.runId === "string" ? { linkedRunId: payload.runId } : {}),
              ...(type === "failed" && typeof payload.message === "string" ? { error: payload.message } : {}),
              status,
              updatedAt: now,
            },
          });
          await transaction.qaseyConversationEventRecord.create({ data: {
            ...owner, conversationId, turnId, sequence, type, payload: payload as Prisma.InputJsonValue, occurredAt: now,
          } });
          await transaction.qaseyConversationRecord.update({
            where: { applicationId_tenantId_id: { ...owner, id: conversationId } },
            data: { ...(status === "running" ? {} : { activeTurnId: null }), updatedAt: now },
          });
          return event;
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
          if ((prismaErrorCode(error) === "P2034" || prismaErrorCode(error) === "P2002") && attempt < 2) continue;
          throw error;
        }
      }
      throw new Error("Unable to append a conversation event after concurrent updates");
    });
  }

  async events(owner: OwnerScope, subjectId: string, conversationId: string, turnId: string, after = 0): Promise<QaseyConversationEvent[]> {
    if (!await this.getConversation(owner, subjectId, conversationId)) return [];
    const rows = await this.prisma.qaseyConversationEventRecord.findMany({
      where: { ...owner, conversationId, turnId, sequence: { gt: Math.max(0, after) } }, orderBy: { sequence: "asc" },
    });
    return rows.map(eventFromRow);
  }

  async failStale(before: Date): Promise<number> {
    await this.ready();
    const stale = await this.prisma.qaseyConversationTurnRecord.findMany({ where: { status: "running", updatedAt: { lt: before } } });
    let count = 0;
    for (const turn of stale) {
      const conversation = await this.prisma.qaseyConversationRecord.findUnique({ where: { applicationId_tenantId_id: { applicationId: turn.applicationId, tenantId: turn.tenantId, id: turn.conversationId } } });
      if (!conversation || conversation.activeTurnId !== turn.id) continue;
      try {
        await this.appendEvent(
          { applicationId: turn.applicationId, tenantId: turn.tenantId }, conversation.subjectId,
          turn.conversationId, turn.id, "failed", { message: "服务重启或执行超时，请重试这条消息。" },
        );
        count += 1;
      } catch (error) {
        if (!(error instanceof ConversationTurnClosedError)) throw error;
      }
    }
    return count;
  }

  async close(): Promise<void> {}

  private async withAppendLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.appendTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.appendTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.appendTails.get(key) === tail) this.appendTails.delete(key);
    }
  }
}

function conversationTitle(message: string): string {
  const firstLine = message.trim().split(/\r?\n/u, 1)[0] ?? "新 QA 任务";
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

function boundedLimit(limit: number): number { return Math.min(Math.max(Math.trunc(limit) || 50, 1), 100); }
function prismaErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
function ownerPrefix(owner: OwnerScope): string { return `${owner.applicationId}\u0000${owner.tenantId}\u0000`; }
function ownerKey(owner: OwnerScope, id: string): string { return `${ownerPrefix(owner)}${id}`; }

function conversationFromRow(row: {
  applicationId: string; tenantId: string; id: string; subjectId: string; title: string;
  activeTurnId: string | null; createdAt: Date; updatedAt: Date;
}): QaseyConversation {
  const { activeTurnId, createdAt, updatedAt, ...record } = row;
  return QaseyConversationSchema.parse({
    ...record, ...(activeTurnId ? { activeTurnId } : {}),
    createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
  });
}

function turnFromRow(row: {
  applicationId: string; tenantId: string; id: string; conversationId: string; clientMessageId: string;
  userMessage: string; assistantText: string; status: string; agentRunId: string | null; linkedRunId: string | null;
  error: string | null; eventSequence: number; createdAt: Date; updatedAt: Date;
}): QaseyConversationTurn {
  const { agentRunId, linkedRunId, error, eventSequence: _eventSequence, createdAt, updatedAt, ...record } = row;
  return QaseyConversationTurnSchema.parse({
    ...record,
    ...(agentRunId ? { agentRunId } : {}),
    ...(linkedRunId ? { linkedRunId } : {}),
    ...(error ? { error } : {}),
    createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
  });
}

function eventFromRow(row: {
  applicationId: string; tenantId: string; conversationId: string; turnId: string; sequence: number;
  type: string; payload: Prisma.JsonValue; occurredAt: Date;
}): QaseyConversationEvent {
  return QaseyConversationEventSchema.parse({ ...row, occurredAt: row.occurredAt.toISOString() });
}
