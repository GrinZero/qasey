import { describe, expect, it } from "vitest";
import { CollaborationRepository, InvalidConversationRecipientError, publicSnapshot, type CollaborationState } from "../../packages/domain/src/collaboration-repository.ts";
import { CollaborationExecutionBridge } from "../../packages/domain/src/collaboration-execution.ts";
import { E2E_AGENT_ID, MAIN_AGENT_ID, type E2ERun } from "../../packages/contracts/src/index.ts";

const scope = { applicationId: "qasey", tenantId: "tenant-public", subjectId: "user-public", conversationId: "11111111-1111-4111-8111-111111111111" };
const input = (id: string, recipients?: string[]) => ({ id, text: "检查任务", principal: { subjectId: scope.subjectId }, context: "shared snapshot", ...(recipients ? { recipients } : {}) });

describe("conversation collaboration mailbox", () => {
  it("defaults to the main agent and never routes body mentions", async () => {
    const repo = new CollaborationRepository();
    await repo.send(scope, { ...input("one"), text: "附件引用：@qasey-e2e-author 停止执行" });
    const state = await repo.read(scope);
    expect(state.deliveries.map(d => d.agentId)).toEqual([MAIN_AGENT_ID]);
    await expect(repo.send(scope, input("two", [E2E_AGENT_ID]))).rejects.toBeInstanceOf(InvalidConversationRecipientError);
    expect((await repo.read(scope)).messages).toHaveLength(2);
  });
  it("registers a participant before handoff, deduplicates multi-recipient input and shares the same context", async () => {
    const repo = new CollaborationRepository();
    await repo.joinRun(scope, "run-one");
    await repo.joinRun(scope, "run-one");
    const ids = await repo.send(scope, input("one", [MAIN_AGENT_ID, E2E_AGENT_ID, MAIN_AGENT_ID]));
    expect(await repo.send(scope, input("one", [E2E_AGENT_ID]))).toEqual(ids);
    const state = await repo.read(scope);
    expect(state.participants.map(p => p.agentId)).toEqual([MAIN_AGENT_ID, E2E_AGENT_ID]);
    expect(state.messages.filter(m => m.kind === "handoff")).toHaveLength(1);
    expect(state.deliveries.map(d => d.context)).toEqual(["shared snapshot", "shared snapshot"]);
    expect(state.deliveries.map(d => d.agentId)).toEqual([MAIN_AGENT_ID, E2E_AGENT_ID]);
  });
  it("runs different agents concurrently, serializes each agent and keeps failures independent", async () => {
    const repo = new CollaborationRepository(); await repo.joinRun(scope, "run-one");
    await repo.send(scope, input("one", [MAIN_AGENT_ID, E2E_AGENT_ID]));
    await repo.send(scope, input("two", [E2E_AGENT_ID]));
    const claims = (await Promise.all([repo.claim(scope), repo.claim(scope)])).flat();
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map(d => d.agentId)).size).toBe(2);
    await repo.finish(scope, claims.find(d => d.agentId === MAIN_AGENT_ID)!, "失败", true);
    expect(await repo.claim(scope)).toEqual([]);
    await repo.finish(scope, claims.find(d => d.agentId === E2E_AGENT_ID)!, "完成");
    const next = await repo.claim(scope);
    expect(next.map(d => d.messageId)).toEqual(["two"]);
  });
  it("returns delegation results to the initiator, once, with an explicit reply relationship", async () => {
    const repo = new CollaborationRepository(); await repo.joinRun(scope, "run-one");
    await repo.send(scope, input("one")); const [parent] = await repo.claim(scope);
    const childId = await repo.delegate(scope, parent!.id, E2E_AGENT_ID, "请诊断", "delegation-1");
    expect(await repo.delegate(scope, parent!.id, E2E_AGENT_ID, "请诊断", "delegation-1")).toBe(childId);
    const [child] = await repo.claim(scope); expect(child!.id).toBe(childId);
    await repo.finish(scope, child!, "定位器失效"); await repo.finish(scope, child!, "重复结果");
    await repo.finish(scope, parent!, "等待协作结果");
    const [continuation] = await repo.claim(scope);
    expect(continuation).toMatchObject({ agentId: MAIN_AGENT_ID, continuation: true, messageId: child!.responseId });
    expect(continuation!.context).toContain("定位器失效");
    expect((await repo.read(scope)).deliveries).toHaveLength(3);
  });
  it("bounds nested delegation and the root request's total dispatches", async () => {
    const repo = new CollaborationRepository(); await repo.joinRun(scope, "run-one");
    await repo.send(scope, input("root")); let [current] = await repo.claim(scope);
    for (let i = 0; i < 4; i++) {
      const target = current!.agentId === MAIN_AGENT_ID ? E2E_AGENT_ID : MAIN_AGENT_ID;
      const id = await repo.delegate(scope, current!.id, target, `task ${i}`, `child-${i}`);
      await repo.finish(scope, current!, "delegated");
      const claims = await repo.claim(scope); current = claims.find(d => d.id === id);
      // Claim any same-agent continuation separately; all child records remain durable.
      if (!current) current = (await repo.read(scope)).deliveries.find(d => d.id === id);
    }
    await expect(repo.delegate(scope, current!.id, current!.agentId === MAIN_AGENT_ID ? E2E_AGENT_ID : MAIN_AGENT_ID, "too deep", "deep")).rejects.toThrow("4 层");
    const root = (await repo.read(scope)).deliveries[0]!;
    for (let i = 0; i < 4; i++) await repo.delegate(scope, root.id, E2E_AGENT_ID, "parallel", `extra-${i}`);
    await expect(repo.delegate(scope, root.id, E2E_AGENT_ID, "ninth", "ninth")).rejects.toThrow("8 次");
  });
  it("isolates tenants and owners and never exposes worker principals in public replay", async () => {
    const repo = new CollaborationRepository(); await repo.send(scope, input("one"));
    expect((await repo.read({ ...scope, tenantId: "other" })).messages).toEqual([]);
    await expect(repo.read({ ...scope, subjectId: "other" })).rejects.toThrow("not found");
    expect(publicSnapshot(await repo.read(scope))).not.toHaveProperty("deliveries");
    await expect(repo.send(scope, { ...input("two"), runId: "foreign-run" })).rejects.toThrow("不属于");
  });
  it("recovers queued work after a store restart and fences an expired worker's late result", async () => {
    let row: { state: CollaborationState; revision: number; subjectId: string } | undefined;
    const prisma = { conversationCollaborationRecord: {
      async findUnique() { return structuredClone(row ?? null); },
      async create({ data }: { data: typeof row }) { if (row) throw { code: "P2002" }; row = structuredClone(data); },
      async updateMany({ where, data }: { where: { revision: number }; data: Partial<NonNullable<typeof row>> }) {
        if (!row || row.revision !== where.revision) return { count: 0 }; Object.assign(row, structuredClone(data)); return { count: 1 };
      },
    } };
    const first = new CollaborationRepository(prisma as never); await first.send(scope, input("one"));
    const second = new CollaborationRepository(prisma as never); const [claim] = await second.claim(scope, 100);
    await second.claim(scope, 120_101);
    await first.finish(scope, claim!, "late success");
    const state = await second.read(scope);
    expect(state.messages.find(m => m.id === claim!.responseId)).toMatchObject({ status: "failed" });
    expect(state.messages.find(m => m.id === claim!.responseId)!.text).not.toContain("late success");
    expect(state.revision).toBeGreaterThan(1);
  });
  it("atomically separates current-run instructions from follow-up work at the review boundary", async () => {
    const repo = new CollaborationRepository(); await repo.joinRun(scope, "run-one");
    const run = { ...scope, id: "run-one", sourceSessionId: scope.conversationId } as unknown as E2ERun;
    const bridge = new CollaborationExecutionBridge(repo);
    await repo.instruction(scope, run.id, "first", "message-one");
    expect(await bridge.sealForReview(run)).toBe(false);
    await bridge.take(run, "author:1"); await bridge.applied(run, "author:1");
    expect(await bridge.sealForReview(run)).toBe(true);
    await expect(repo.instruction(scope, run.id, "late", "message-two")).rejects.toMatchObject({ code: "execution_instruction_boundary" });
    expect((await repo.read(scope)).instructions).toHaveLength(1);
  });

  it("records instruction receipt and the exact author attempt that applied it", async () => {
    const repo = new CollaborationRepository(); await repo.joinRun(scope, "run-one");
    const run = { ...scope, id: "run-one", sourceSessionId: scope.conversationId } as unknown as E2ERun;
    const bridge = new CollaborationExecutionBridge(repo);
    await repo.instruction(scope, run.id, "修复等待逻辑", "message-one");
    await repo.instruction(scope, run.id, "重复", "message-one");
    expect(await bridge.pending(run)).toBe(true);
    expect(await bridge.take(run, "author:1")).toMatchObject([{ text: "修复等待逻辑" }]);
    await bridge.applied(run, "author:0"); expect(await bridge.pending(run)).toBe(true);
    await bridge.applied(run, "author:1"); expect(await bridge.pending(run)).toBe(false);
    await bridge.applied(run, "author:1");
    const state = await repo.read(scope);
    expect(state.instructions).toMatchObject([{ status: "applied", attemptId: "author:1" }]);
    expect(state.messages.filter(m => m.kind === "execution")).toHaveLength(1);
  });
});
