import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { MAIN_AGENT_ID, E2E_AGENT_ID, type CollaborationMessage, type CollaborationSnapshot, type ConversationParticipant, type OwnerScope } from "../../contracts/src/index.ts";

export const conversationAgents: Record<string, { name: string; description: string }> = {
  [MAIN_AGENT_ID]: { name: "Qasey", description: "协调需求、文字用例与协作交接" },
  [E2E_AGENT_ID]: { name: "E2E Agent", description: "编写、验证和修复 Playwright，回答执行问题" },
};
export interface CollaborationScope extends OwnerScope { conversationId: string; subjectId: string }
export interface AgentDelivery {
  id: string; messageId: string; responseId: string; agentId: string; rootMessageId: string;
  depth: number; status: "queued" | "running" | "completed" | "failed";
  context: string; principal: Record<string, unknown>; action?: Record<string, unknown>;
  runId?: string; turnId?: string; parentDeliveryId?: string; continuation?: boolean;
  leaseUntil?: number; claim?: string; createdAt: string;
}
export interface ExecutionInstruction {
  id: string; runId: string; text: string; messageId: string;
  status: "pending" | "applying" | "applied"; attemptId?: string;
}
export interface CollaborationState extends CollaborationSnapshot {
  deliveries: AgentDelivery[]; instructions: ExecutionInstruction[];
  runs: Array<{ runId: string; turnId?: string; since: string; acceptingInstructions?: boolean }>;
  receipts: string[];
}
const initial = (): CollaborationState => ({ revision: 0,
  participants: [{ agentId: MAIN_AGENT_ID, ...conversationAgents[MAIN_AGENT_ID]!, introducedBy: "system", joinedAt: new Date().toISOString() }],
  messages: [], deliveries: [], instructions: [], runs: [], receipts: [],
});
export class ExecutionInstructionBoundaryError extends Error {
  readonly code = "execution_instruction_boundary";
  constructor() { super("本次执行已交付，请创建后续执行应用补充要求。"); }
}
export class InvalidConversationRecipientError extends Error {
  readonly code = "invalid_conversation_recipient";
}
export class CollaborationRepository {
  private memory = new Map<string, { scope: CollaborationScope; state: CollaborationState }>();
  constructor(private prisma?: PrismaClient) {}
  private key(s: CollaborationScope): string { return JSON.stringify([s.applicationId, s.tenantId, s.conversationId]); }
  async read(scope: CollaborationScope): Promise<CollaborationState> {
    if (!this.prisma) {
      const row = this.memory.get(this.key(scope));
      if (row && row.scope.subjectId !== scope.subjectId) throw new Error("Conversation not found");
      return structuredClone(row?.state ?? initial());
    }
    const row = await this.prisma.conversationCollaborationRecord.findUnique({ where: { applicationId_tenantId_conversationId: {
      applicationId: scope.applicationId, tenantId: scope.tenantId, conversationId: scope.conversationId,
    } } });
    if (row && row.subjectId !== scope.subjectId) throw new Error("Conversation not found");
    return row ? { ...(row.state as unknown as CollaborationState), revision: row.revision } : initial();
  }
  // Pure synchronous reducer; a revision conflict retries without repeating external effects.
  async change<T>(scope: CollaborationScope, reduce: (state: CollaborationState) => T): Promise<T> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const state = await this.read(scope);
      const revision = state.revision;
      const result = reduce(state);
      state.revision++;
      if (!this.prisma) {
        const current = this.memory.get(this.key(scope));
        if ((current?.state.revision ?? 0) !== revision) continue;
        this.memory.set(this.key(scope), { scope: structuredClone(scope), state: structuredClone(state) });
        return structuredClone(result);
      }
      const where = { applicationId: scope.applicationId, tenantId: scope.tenantId, conversationId: scope.conversationId };
      const data = { revision: state.revision, state: state as unknown as Prisma.InputJsonValue, updatedAt: new Date() };
      if (revision === 0) {
        try { await this.prisma.conversationCollaborationRecord.create({ data: { ...scope, ...data } }); return result; }
        catch (error) { if ((error as { code?: string }).code === "P2002") continue; throw error; }
      }
      const updated = await this.prisma.conversationCollaborationRecord.updateMany({ where: { ...where, subjectId: scope.subjectId, revision }, data });
      if (updated.count) return result;
    }
    throw new Error("Conversation mailbox is busy; retry the same message ID");
  }
  async scopes(): Promise<CollaborationScope[]> {
    if (!this.prisma) return [...this.memory.values()].map(row => structuredClone(row.scope));
    return this.prisma.conversationCollaborationRecord.findMany({ select: { applicationId: true, tenantId: true, conversationId: true, subjectId: true } }) as Promise<CollaborationScope[]>;
  }
  async send(scope: CollaborationScope, input: {
    id: string; text: string; recipients?: string[]; principal: Record<string, unknown>; context: string;
    runId?: string; action?: Record<string, unknown>; turnId?: string;
  }): Promise<string[]> {
    return this.change(scope, state => {
      const prior = state.messages.find(message => message.id === input.id);
      if (prior) return state.deliveries.filter(delivery => delivery.messageId === input.id).map(delivery => delivery.id);
      const recipients = [...new Set(input.recipients ?? [MAIN_AGENT_ID])];
      if (!recipients.length || recipients.some(id => !state.participants.some(p => p.agentId === id))) {
        throw new InvalidConversationRecipientError("只能 @ 已加入当前会话的 Agent。");
      }
      if (input.runId && !state.runs.some(run => run.runId === input.runId)) throw new InvalidConversationRecipientError("指定运行不属于当前会话。");
      const createdAt = new Date().toISOString();
      state.messages.push({ id: input.id, text: input.text, recipientAgentIds: recipients, role: "user", kind: "message", status: "completed", createdAt, rootMessageId: input.id, ...(input.runId ? { runId: input.runId } : {}) });
      return recipients.map(agentId => enqueue(state, {
        messageId: input.id, agentId, rootMessageId: input.id, depth: 0, context: input.context,
        principal: input.principal, ...(input.runId ? { runId: input.runId } : {}), ...(input.action ? { action: input.action } : {}), ...(input.turnId ? { turnId: input.turnId } : {}),
      }).id);
    });
  }
  async delegate(scope: CollaborationScope, deliveryId: string, agentId: string, text: string, idempotencyKey: string): Promise<string> {
    return this.change(scope, state => {
      const prior = state.deliveries.find(d => d.messageId === idempotencyKey);
      if (prior) return prior.id;
      const parent = state.deliveries.find(d => d.id === deliveryId);
      if (!parent) throw new Error("Unknown collaboration request");
      if (!state.participants.some(p => p.agentId === agentId) || agentId === parent.agentId) throw new InvalidConversationRecipientError("请选择另一位已加入的 Agent。");
      if (parent.depth >= 4 || state.deliveries.filter(d => d.rootMessageId === parent.rootMessageId && d.parentDeliveryId && !d.continuation).length >= 8) {
        throw new Error("已达到本条消息的协作上限（8 次委派 / 4 层），请报告尚未完成的事项。");
      }
      state.messages.push({ id: idempotencyKey, authorAgentId: parent.agentId, recipientAgentIds: [agentId], role: "assistant", kind: "handoff", status: "completed", text,
        createdAt: new Date().toISOString(), replyTo: parent.responseId, rootMessageId: parent.rootMessageId });
      return enqueue(state, { messageId: idempotencyKey, agentId, rootMessageId: parent.rootMessageId, depth: parent.depth + 1,
        context: sharedContext(state), principal: parent.principal, parentDeliveryId: parent.id, ...(parent.runId ? { runId: parent.runId } : {}) }).id;
    });
  }
  async claim(scope: CollaborationScope, now = Date.now()): Promise<AgentDelivery[]> {
    return this.change(scope, state => {
      for (const d of state.deliveries) if (d.status === "running" && (d.leaseUntil ?? 0) < now) {
        // Never replay an uncertain tool mutation after losing its worker.
        d.status = "failed";
        const message = state.messages.find(m => m.id === d.responseId)!;
        message.status = "failed"; message.text += "\n执行连接已中断。已有后台任务会继续汇报；请重新发送尚未完成的请求。";
      }
      const active = new Set(state.deliveries.filter(d => d.status === "running").map(d => d.agentId));
      const claimed: AgentDelivery[] = [];
      for (const d of state.deliveries) if (d.status === "queued" && !active.has(d.agentId)) {
        active.add(d.agentId); d.status = "running"; d.claim = randomUUID(); d.leaseUntil = now + 120_000;
        state.messages.find(m => m.id === d.responseId)!.status = "running";
        claimed.push(structuredClone(d));
      }
      return claimed;
    });
  }
  async finish(scope: CollaborationScope, delivery: AgentDelivery, text: string, failed = false): Promise<void> {
    await this.change(scope, state => {
      const current = state.deliveries.find(d => d.id === delivery.id);
      if (!current || current.claim !== delivery.claim || current.status !== "running") return;
      current.status = failed ? "failed" : "completed";
      Object.assign(state.messages.find(m => m.id === current.responseId)!, { text, status: current.status });
      if (current.parentDeliveryId && !current.continuation) {
        const parent = state.deliveries.find(d => d.id === current.parentDeliveryId)!;
        enqueue(state, { messageId: current.responseId, agentId: parent.agentId, rootMessageId: parent.rootMessageId,
          depth: parent.depth, context: sharedContext(state), principal: parent.principal,
          parentDeliveryId: parent.id, continuation: true, ...(parent.runId ? { runId: parent.runId } : {}) });
      }
    });
  }
  async joinRun(scope: CollaborationScope, runId: string, turnId?: string): Promise<void> {
    await this.change(scope, state => {
      const existing = state.runs.find(run => run.runId === runId);
      if (existing) {
        if (turnId && !existing.turnId) {
          existing.turnId = turnId;
          for (const message of state.messages) if (message.runId === runId && message.rootMessageId === runId) message.rootMessageId = turnId;
        }
        return;
      }
      join(state, E2E_AGENT_ID, MAIN_AGENT_ID);
      state.runs.push({ runId, ...(turnId ? { turnId } : {}), since: new Date().toISOString() });
      state.messages.push({ id: `handoff:${runId}`, authorAgentId: MAIN_AGENT_ID, recipientAgentIds: [E2E_AGENT_ID], role: "assistant", kind: "handoff", status: "completed", text: "已将批准的文字用例交给 E2E Agent。它会在这里汇报编写、验证和交付结果，你可以 @ 它追问或补充要求。", createdAt: new Date().toISOString(), runId, rootMessageId: turnId ?? runId });
    });
  }
  async instruction(scope: CollaborationScope, runId: string, text: string, messageId: string): Promise<ExecutionInstruction> {
    return this.change(scope, state => {
      const prior = state.instructions.find(i => i.messageId === messageId && i.runId === runId);
      if (prior) return prior;
      const run = state.runs.find(r => r.runId === runId);
      if (!run) throw new Error("运行不属于当前会话");
      if (run.acceptingInstructions === false) throw new ExecutionInstructionBoundaryError();
      const instruction: ExecutionInstruction = { id: randomUUID(), runId, text, messageId, status: "pending" };
      state.instructions.push(instruction); return instruction;
    });
  }
}
export function join(state: CollaborationState, agentId: string, introducedBy: string): void {
  if (state.participants.some(p => p.agentId === agentId)) return;
  const definition = conversationAgents[agentId];
  if (!definition) throw new InvalidConversationRecipientError("未知 Agent");
  state.participants.push({ agentId, ...definition, introducedBy, joinedAt: new Date().toISOString() });
}
function enqueue(state: CollaborationState, input: Omit<AgentDelivery, "id" | "responseId" | "status" | "createdAt">): AgentDelivery {
  const d: AgentDelivery = { ...input, id: randomUUID(), responseId: input.turnId ?? randomUUID(), status: "queued", createdAt: new Date().toISOString() };
  state.deliveries.push(d);
  state.messages.push({ id: d.responseId, authorAgentId: d.agentId, recipientAgentIds: [], role: "assistant", kind: "message", text: "", status: "queued", createdAt: d.createdAt, ...(d.turnId ? { turnId: d.turnId } : {}), replyTo: d.messageId, rootMessageId: d.rootMessageId, ...(d.runId ? { runId: d.runId } : {}) });
  return d;
}
export function publicSnapshot(state: CollaborationState): CollaborationSnapshot {
  return { revision: state.revision, participants: state.participants, messages: state.messages };
}
export function sharedContext(state: CollaborationState): string {
  return JSON.stringify(state.messages.filter(m => m.status === "completed" || m.status === "failed").slice(-80).map(m => ({
    author: m.authorAgentId ?? "user", recipients: m.recipientAgentIds, text: m.text.slice(-12_000), runId: m.runId,
  })));
}
