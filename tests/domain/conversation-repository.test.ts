import { describe, expect, it } from "vitest";
import {
  ConversationBusyError,
  ConversationTurnClosedError,
  InMemoryQaseyConversationRepository,
  PrismaQaseyConversationRepository,
} from "../../packages/domain/src/index.ts";

const owner = { applicationId: "qasey" as const, tenantId: "tenant-1" };

describe("Qasey conversation repository", () => {
  it("isolates conversations by tenant and subject and orders them by recent activity", async () => {
    let now = new Date("2026-09-04T01:00:00.000Z");
    const repository = new InMemoryQaseyConversationRepository(() => now);
    const first = await repository.createConversation(owner, "qa-1");
    now = new Date("2026-09-04T01:01:00.000Z");
    const second = await repository.createConversation(owner, "qa-1");

    expect((await repository.listConversations(owner, "qa-1")).map(item => item.id)).toEqual([second.id, first.id]);
    expect(await repository.getConversation(owner, "qa-2", first.id)).toBeUndefined();
    expect(await repository.getConversation({ ...owner, tenantId: "tenant-2" }, "qa-1", first.id)).toBeUndefined();
  });

  it("deduplicates client messages, blocks overlapping turns, and replays ordered events", async () => {
    const repository = new InMemoryQaseyConversationRepository(() => new Date("2026-09-04T02:00:00.000Z"));
    const conversation = await repository.createConversation(owner, "qa-1");
    const clientMessageId = "11111111-1111-4111-8111-111111111111";
    const started = await repository.startTurn(owner, "qa-1", conversation.id, clientMessageId, "验证预约改期流程");
    const duplicate = await repository.startTurn(owner, "qa-1", conversation.id, clientMessageId, "不会覆盖原消息");

    expect(started.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.turn.id).toBe(started.turn.id);
    expect(duplicate.turn.userMessage).toBe("验证预约改期流程");
    await expect(repository.startTurn(
      owner, "qa-1", conversation.id, "22222222-2222-4222-8222-222222222222", "并发消息",
    )).rejects.toBeInstanceOf(ConversationBusyError);

    await repository.appendEvent(owner, "qa-1", conversation.id, started.turn.id, "progress", {
      title: "正在分析需求", detail: "只保留可读进度",
    });
    await repository.appendEvent(owner, "qa-1", conversation.id, started.turn.id, "assistant.delta", { text: "已分析" });
    await repository.appendEvent(owner, "qa-1", conversation.id, started.turn.id, "completed", { text: "已分析完成" });

    const replay = await repository.events(owner, "qa-1", conversation.id, started.turn.id, 2);
    expect(replay.map(event => [event.sequence, event.type])).toEqual([[3, "assistant.delta"], [4, "completed"]]);
    expect((await repository.listTurns(owner, "qa-1", conversation.id))[0]).toMatchObject({
      assistantText: "已分析完成", status: "completed",
    });
    expect((await repository.getConversation(owner, "qa-1", conversation.id))?.activeTurnId).toBeUndefined();
  });

  it("marks a stale active turn as failed so the conversation can be retried", async () => {
    const repository = new InMemoryQaseyConversationRepository(() => new Date("2026-09-04T03:00:00.000Z"));
    const conversation = await repository.createConversation(owner, "qa-1");
    const started = await repository.startTurn(
      owner, "qa-1", conversation.id, "33333333-3333-4333-8333-333333333333", "需要恢复的任务",
    );

    expect(await repository.failStale(new Date("2026-09-04T03:01:00.000Z"))).toBe(1);
    const [turn] = await repository.listTurns(owner, "qa-1", conversation.id);
    expect(turn).toMatchObject({ status: "failed", error: "服务重启或执行超时，请重试这条消息。" });
    expect((await repository.events(owner, "qa-1", conversation.id, started.turn.id)).at(-1)?.type).toBe("failed");
    await expect(repository.appendEvent(
      owner, "qa-1", conversation.id, started.turn.id, "completed", { text: "迟到的结果" },
    )).rejects.toBeInstanceOf(ConversationTurnClosedError);
    expect((await repository.listTurns(owner, "qa-1", conversation.id))[0]).toMatchObject({
      assistantText: "", status: "failed",
    });
    await expect(repository.startTurn(
      owner, "qa-1", conversation.id, "44444444-4444-4444-8444-444444444444", "重试任务",
    )).resolves.toMatchObject({ created: true });
  });

  it("does not expose Prisma's internal event sequence when projecting turns", async () => {
    const now = new Date("2026-09-04T04:00:00.000Z");
    const conversationId = "55555555-5555-4555-8555-555555555555";
    const prisma = {
      $connect: async () => undefined,
      qaseyConversationRecord: {
        findUnique: async () => ({
          ...owner,
          id: conversationId,
          subjectId: "qa-1",
          title: "验证数据库投影",
          activeTurnId: null,
          createdAt: now,
          updatedAt: now,
        }),
      },
      qaseyConversationTurnRecord: {
        findMany: async () => [{
          ...owner,
          id: "66666666-6666-4666-8666-666666666666",
          conversationId,
          clientMessageId: "77777777-7777-4777-8777-777777777777",
          userMessage: "验证数据库投影",
          assistantText: "投影正常",
          status: "completed",
          agentRunId: null,
          linkedRunId: null,
          error: null,
          eventSequence: 3,
          createdAt: now,
          updatedAt: now,
        }],
      },
    };
    const repository = new PrismaQaseyConversationRepository(prisma as never);
    await repository.init();

    const [turn] = await repository.listTurns(owner, "qa-1", conversationId);

    expect(turn).toMatchObject({ assistantText: "投影正常", status: "completed" });
    expect(turn).not.toHaveProperty("eventSequence");
  });

  it("serializes concurrent event appends for the same turn", async () => {
    const now = new Date("2026-09-04T05:00:00.000Z");
    const conversationId = "88888888-8888-4888-8888-888888888888";
    const turnId = "99999999-9999-4999-8999-999999999999";
    let eventSequence = 1;
    let activeTransactions = 0;
    let maximumActiveTransactions = 0;
    const transaction = {
      qaseyConversationRecord: {
        findUnique: async () => ({
          ...owner, id: conversationId, subjectId: "qa-1", title: "并发事件",
          activeTurnId: turnId, createdAt: now, updatedAt: now,
        }),
        update: async () => undefined,
      },
      qaseyConversationTurnRecord: {
        findUnique: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return {
            ...owner, id: turnId, conversationId,
            clientMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            userMessage: "并发事件", assistantText: "", status: "running",
            agentRunId: null, linkedRunId: null, error: null,
            eventSequence, createdAt: now, updatedAt: now,
          };
        },
        update: async ({ data }: { data: { eventSequence: number } }) => { eventSequence = data.eventSequence; },
      },
      qaseyConversationEventRecord: { create: async () => undefined },
    };
    const prisma = {
      $connect: async () => undefined,
      $transaction: async (operation: (value: typeof transaction) => Promise<unknown>) => {
        activeTransactions += 1;
        maximumActiveTransactions = Math.max(maximumActiveTransactions, activeTransactions);
        try { return await operation(transaction); } finally { activeTransactions -= 1; }
      },
    };
    const repository = new PrismaQaseyConversationRepository(prisma as never, () => now);
    await repository.init();

    const events = await Promise.all([
      repository.appendEvent(owner, "qa-1", conversationId, turnId, "progress", { title: "一" }),
      repository.appendEvent(owner, "qa-1", conversationId, turnId, "progress", { title: "二" }),
      repository.appendEvent(owner, "qa-1", conversationId, turnId, "progress", { title: "三" }),
    ]);

    expect(events.map(event => event.sequence)).toEqual([2, 3, 4]);
    expect(maximumActiveTransactions).toBe(1);
  });
});
