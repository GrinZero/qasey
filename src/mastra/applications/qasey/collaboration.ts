import type { PermissionService } from "../../../platform/auth/permission-store.ts";
import type { Mastra, } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { E2E_AGENT_ID, MAIN_AGENT_ID, GenerateE2EConversationActionSchema, type E2ERun } from "../../../../packages/contracts/src/index.ts";
import { type AgentDelivery, type CollaborationScope, sharedContext, ExecutionInstructionBoundaryError, join } from "../../../../packages/domain/src/collaboration-repository.ts";
import { collaborationRepository, conversationRepository, runRepository, e2eCoordinator, caseHubRepository, sideEffectExecutor } from "../../runtime.ts";
import { OAuthPrincipalSchema } from "../../../platform/auth/oauth-principal.ts";
import { prepareQaseyRequestContext } from "./service.ts";
import { cancelE2ERun } from "../../workflows/e2e-workflow.ts";

type ConversationTurnExecutor = typeof import("./routes.ts").executeConversationTurn;

const terminal = ["succeeded", "failed", "cancelled"];
const labels: Record<string, string> = {
  queued: "已接收任务", preparing_workspace: "正在准备隔离环境", authoring: "正在编写测试", author_running: "正在编写和自检",
  repairing: "正在修复测试", clean_verifying: "正在独立验证", awaiting_qa: "独立验证已通过，等待审核", succeeded: "任务已完成", failed: "执行失败", cancelled: "执行已取消",
};

export async function attachConversationRuns(scope: CollaborationScope): Promise<void> {
  const [state, turns] = await Promise.all([collaborationRepository.read(scope), conversationRepository.listTurns(scope, scope.subjectId, scope.conversationId)]);
  const ids = [...new Set(turns.flatMap(t => t.linkedRunId ? [t.linkedRunId] : []))].filter(id => !state.runs.some(r => r.runId === id));
  for (const runId of ids) {
    const run = await runRepository.get(scope, runId);
    if (!run || run.sourceSessionId !== scope.conversationId) continue;
    const events = await runRepository.events(scope, runId);
    await collaborationRepository.change(scope, current => {
      if (current.runs.some(r => r.runId === runId)) return;
      join(current, E2E_AGENT_ID, MAIN_AGENT_ID);
      current.runs.push({ runId, since: new Date().toISOString() });
      current.receipts.push(...events.map(e => e.id));
      current.messages.push({ id: `restored:${runId}`, authorAgentId: E2E_AGENT_ID, recipientAgentIds: [], role: "assistant", kind: "execution", status: "completed",
        text: `历史任务当前状态：${labels[run.status] ?? run.status}。${run.error ?? ""}`, createdAt: new Date().toISOString(), rootMessageId: runId, runId });
    });
  }
}

export async function projectRunEvents(scope: CollaborationScope): Promise<void> {
  const state = await collaborationRepository.read(scope);
  for (const link of state.runs) {
    const [run, events] = await Promise.all([runRepository.get(scope, link.runId), runRepository.events(scope, link.runId)]);
    if (!run) continue;
    const pending = events.filter(event => !state.receipts.includes(event.id));
    if (!pending.length) continue;
    await collaborationRepository.change(scope, current => {
      for (const event of pending) {
        if (current.receipts.includes(event.id)) continue;
        current.receipts.push(event.id);
        if (!event.type.startsWith("run.") || event.type === "run.context_frozen") continue;
        const status = event.type.slice(4) === "created" ? "queued" : event.type.slice(4);
        if (!labels[status]) continue;
        const currentEvent = status === run.status;
        let text = labels[status]!;
        if (status === "failed") text += `。${event.message}\n请查看运行证据；可以 @ E2E Agent 诊断并提出修复要求。`;
        if (status === "awaiting_qa" || status === "succeeded") text += `。\n[查看运行与证据](/runs/${encodeURIComponent(run.id)}) · [审核结果](/admin/apps/qasey/reviews)${run.pullRequestUrl ? ` · [查看 PR](${run.pullRequestUrl})` : ""}`;
        if (currentEvent && run.artifacts.length) text += "\n" + run.artifacts.filter(a => ["trace", "video", "report"].includes(a.kind)).slice(0, 4).map(a => `[${a.name}](/v1/case-hub/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(a.id)})`).join(" · ");
        current.messages.push({ id: `event:${event.id}`, authorAgentId: E2E_AGENT_ID, recipientAgentIds: [], role: "assistant", kind: "execution", status: status === "failed" ? "failed" : "completed", text, createdAt: event.at, runId: run.id, rootMessageId: link.turnId ?? run.id });
      }
    });
  }
}

export async function acceptCollaborationMessage(scope: CollaborationScope, input: {
  id: string; text: string; recipients?: string[]; principal: Record<string, unknown>; runId?: string;
}): Promise<string[]> {
  if (!await conversationRepository.getConversation(scope, scope.subjectId, scope.conversationId)) throw new Error("Conversation not found");
  const [state, turns] = await Promise.all([collaborationRepository.read(scope), conversationRepository.listTurns(scope, scope.subjectId, scope.conversationId)]);
  const legacy = turns.filter(t => !state.messages.some(m => m.turnId === t.id)).slice(-20).map(t => ({ author: MAIN_AGENT_ID, user: t.userMessage, text: t.assistantText }));
  return collaborationRepository.send(scope, { ...input, context: JSON.stringify({ legacy, conversation: JSON.parse(sharedContext(state)) }) });
}

export function toolsForDelivery(mastra: Mastra, scope: CollaborationScope, delivery: AgentDelivery, permissions: PermissionService) {
  const selectRun = async (id?: string): Promise<E2ERun> => {
    const state = await collaborationRepository.read(scope);
    const ids = state.runs.map(r => r.runId);
    const chosen = id ?? delivery.runId ?? (ids.length === 1 ? ids[0] : undefined);
    if (!chosen || !ids.includes(chosen)) throw new Error("请让用户明确指定当前会话中的 run；存在多个任务时不要猜测。");
    const run = await runRepository.get(scope, chosen);
    if (!run || run.sourceSessionId !== scope.conversationId) throw new Error("运行不属于当前会话。");
    return run;
  };
  return {
    delegate_agent: createTool({ id: "delegate_agent", description: "向当前会话的另一位参与 Agent 发起可见协作。结果会自动回到此会话并唤醒你，不要重复委派或轮询。", inputSchema: z.object({ agentId: z.string(), message: z.string().min(1).max(8000) }), execute: async (input) => {
      await requireDeliveryPermission(permissions, delivery, input.agentId === E2E_AGENT_ID ? "qasey.e2e.execute" : "qasey.agent.execute");
      const key = `${delivery.id}:delegate:${input.agentId}:${input.message}`;
      return { deliveryId: await collaborationRepository.delegate(scope, delivery.id, input.agentId, input.message, key), status: "queued" };
    } }),
    conversation_runs: createTool({ id: "conversation_runs", description: "读取本会话所有 E2E 任务或精确运行的最新状态、失败和证据。只读。", inputSchema: z.object({ runId: z.string().optional() }), execute: async ({ runId }) => {
      await requireDeliveryPermission(permissions, delivery, "qasey.runs.read");
      const state = await collaborationRepository.read(scope);
      if (runId) { const run = await selectRun(runId); return { run, events: await runRepository.events(scope, run.id), instructions: state.instructions.filter(i => i.runId === run.id) }; }
      return { runs: await Promise.all(state.runs.map(r => runRepository.get(scope, r.runId))), instructions: state.instructions };
    } }),
    update_e2e_execution: createTool({ id: "update_e2e_execution", description: "对精确 E2E run 提交实现补充或停止。步骤、预期、范围变化必须选 review_cases，不能修改冻结用例。已结束或待审任务的实现补充会创建后续 run。", inputSchema: z.object({ runId: z.string().optional(), action: z.enum(["amend", "stop", "review_cases"]), message: z.string().min(1).max(5000) }), execute: async ({ runId, action, message }) => {
      await requireDeliveryPermission(permissions, delivery, "qasey.e2e.execute");
      let run = await selectRun(runId);
      if (action === "review_cases") return { status: "text_review_required", message: "请回到文字用例审核修改并重新批准步骤、预期或范围。当前冻结版本未改动。" };
      const principal = OAuthPrincipalSchema.parse(delivery.principal);
      const context = prepareQaseyRequestContext({ requestId: delivery.id, channel: "api", sessionId: scope.conversationId, chatInput: message, actor: { id: scope.subjectId, tenantId: scope.tenantId }, source: {}, attachments: [] }, new RequestContext());
      context.set("platform-principal", principal);
      context.set("identity", { userId: principal.subjectId, tenantId: principal.tenantId, roles: principal.roles, service: principal.service });
      if (action === "stop") return { run: await cancelE2ERun(mastra, scope, run.id) };
      const mailbox = await collaborationRepository.read(scope);
      if (!terminal.includes(run.status) && run.status !== "awaiting_qa" && mailbox.runs.find(r => r.runId === run.id)?.acceptingInstructions !== false) {
        try {
          return { instruction: await collaborationRepository.instruction(scope, run.id, message, delivery.messageId), message: "已接收，将在下一编写或修复节点应用，并重新独立验证。" };
        } catch (error) { if (!(error instanceof ExecutionInstructionBoundaryError)) throw error; }
      }
      {
        const sourceId = run.id;
        const receipt = `followup:${delivery.messageId}:${sourceId}`;
        const state = await collaborationRepository.read(scope);
        const existing = state.instructions.find(i => i.messageId === receipt);
        if (existing) return { run: await runRepository.get(scope, existing.runId), instruction: existing };
        return sideEffectExecutor.execute({
          owner: scope, runId: sourceId, stepId: "conversation-followup", businessKey: receipt,
          request: { sourceId, message },
          operation: async () => {
        const previousChangeSet = await caseHubRepository.getChangeSet(scope, run.changeSetId);
        if (!previousChangeSet) throw new Error("原任务的文字用例已不存在，请重新审核文字用例。");
        const followupChangeSet = await caseHubRepository.createAutomationChangeSet(scope, {
          requirement: previousChangeSet.requirement, caseVersionIds: previousChangeSet.caseVersionIds,
          repository: previousChangeSet.repository, createdBy: scope.subjectId,
          ...(previousChangeSet.baseSha ? { baseSha: previousChangeSet.baseSha } : {}),
          ...(previousChangeSet.environmentSourceSha ? { environmentSourceSha: previousChangeSet.environmentSourceSha } : {}),
        });
        run = await e2eCoordinator.rerun(scope, sourceId, followupChangeSet.id);
        await collaborationRepository.joinRun(scope, run.id);
        const instruction = await collaborationRepository.instruction(scope, run.id, message, receipt);
        const changeSet = await caseHubRepository.getChangeSet(scope, run.changeSetId);
        if (changeSet) await caseHubRepository.updateChangeSet(scope, changeSet.id, changeSet.revision, { status: "verifying", runId: run.id });
        const workflow = await mastra.getWorkflow("qasey-e2e-lifecycle").createRun({ runId: run.id, resourceId: scope.subjectId });
        try { await workflow.startAsync({ inputData: { runId: run.id }, requestContext: context }); }
        catch (error) { await e2eCoordinator.fail(scope, run.id, error); throw error; }
        return { result: { run, sourceRunId: sourceId, instruction }, externalRef: run.id };
          },
        });
      }
    } }),
  };
}

export async function runCollaborationDelivery(
  mastra: Mastra,
  scope: CollaborationScope,
  delivery: AgentDelivery,
  permissions: PermissionService,
  executeConversationTurn: ConversationTurnExecutor,
): Promise<void> {
  const heartbeat = setInterval(() => {
    void collaborationRepository.change(scope, state => {
      const d = state.deliveries.find(d => d.id === delivery.id);
      if (d?.status === "running" && d.claim === delivery.claim) d.leaseUntil = Date.now() + 120_000;
    }).catch(error => console.error("conversation.heartbeat.failed", error instanceof Error ? error.name : "error"));
  }, 30_000);
  heartbeat.unref?.();
  try {
    await requireDeliveryPermission(permissions, delivery, delivery.agentId === E2E_AGENT_ID ? "qasey.e2e.execute" : "qasey.agent.execute");
    const state = await collaborationRepository.read(scope);
    const message = state.messages.find(m => m.id === delivery.messageId)!;
    const principal = OAuthPrincipalSchema.parse(delivery.principal);
    const existingTurn = delivery.turnId ? (await conversationRepository.listTurns(scope, scope.subjectId, scope.conversationId)).find(t => t.id === delivery.turnId) : undefined;
    const started = existingTurn ? { turn: existingTurn } : await conversationRepository.startTurn(scope, scope.subjectId, scope.conversationId, delivery.responseId, message.text || "请继续处理协作结果。");
    await collaborationRepository.change(scope, current => { current.messages.find(m => m.id === delivery.responseId)!.turnId = started.turn.id; });
    await executeConversationTurn({ mastra, principal, owner: { applicationId: scope.applicationId, tenantId: scope.tenantId }, conversationId: scope.conversationId,
      turnId: started.turn.id, message: `${delivery.continuation ? "另一位 Agent 已回复你的协作请求，请结合结果继续处理。\n" : ""}${message.text}`,
      ...(delivery.action ? { action: GenerateE2EConversationActionSchema.parse(delivery.action) } : {}),
      agentId: delivery.agentId, collaborationTools: toolsForDelivery(mastra, scope, delivery, permissions),
      promptContext: `${delivery.context}\n参与者：${JSON.stringify(state.participants)}\n只响应明确指定给你的任务。需要协作时使用 delegate_agent，结果会自动送回。`,
      onLinkedRun: async runId => {
        await collaborationRepository.joinRun(scope, runId, started.turn.id);
        await collaborationRepository.change(scope, current => { current.messages.find(m => m.id === delivery.responseId)!.runId = runId; });
      },
    });
    const completed = (await conversationRepository.listTurns(scope, scope.subjectId, scope.conversationId)).find(t => t.id === started.turn.id)!;
    await collaborationRepository.finish(scope, delivery, completed.assistantText || completed.error || "未返回结果，请重试。", completed.status === "failed");
  } catch (error) {
    await collaborationRepository.finish(scope, delivery, error instanceof Error ? error.message : "Agent 未能完成处理。", true);
  } finally { clearInterval(heartbeat); }
}

export function startCollaborationWorker(
  mastra: Mastra,
  permissions: PermissionService,
  executeConversationTurn: ConversationTurnExecutor,
): { close(): Promise<void>; healthCheck(): Promise<void> } {
  let stopped = false;
  let polling = false;
  let lastError: unknown;
  const running = new Set<Promise<void>>();
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      // Filesystem agents are injected after the composition root is evaluated.
      try { mastra.getAgent(MAIN_AGENT_ID); mastra.getAgent(E2E_AGENT_ID); } catch { return; }
      for (const scope of await collaborationRepository.scopes()) {
        await projectRunEvents(scope);
        const state = await collaborationRepository.read(scope);
        if (!state.deliveries.some(d => d.status === "queued" || d.status === "running" && (d.leaseUntil ?? 0) < Date.now())) continue;
        for (const delivery of await collaborationRepository.claim(scope)) {
          const job = runCollaborationDelivery(mastra, scope, delivery, permissions, executeConversationTurn)
            .catch(error => { lastError = error; })
            .finally(() => running.delete(job));
          running.add(job);
        }
      }
      lastError = undefined;
    } catch (error) { lastError = error; console.error("conversation.worker.failed", error instanceof Error ? error.name : "error"); }
    finally { polling = false; }
  };
  const timer = setInterval(() => { void poll(); }, 1000);
  timer.unref?.(); void poll();
  return { async close() { stopped = true; clearInterval(timer); await Promise.allSettled(running); }, async healthCheck() { if (lastError) throw lastError; } };
}

async function requireDeliveryPermission(permissions: PermissionService, delivery: AgentDelivery, permission: string): Promise<void> {
  const principal = OAuthPrincipalSchema.parse(delivery.principal);
  if (!await permissions.authorize({ principal, applicationId: "qasey", resourceType: "agent", resourceId: delivery.agentId, action: "execute", permission })) {
    throw new Error("当前账号没有执行此 Agent 操作的权限。");
  }
}
