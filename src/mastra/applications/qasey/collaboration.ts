import { approvedReusableVersions } from "./reusable-cases.ts";
import { codeTaskActivity } from "../../../../packages/e2e/src/code-task-activity.ts";
import { ExecutionToolCallSchema, type CollaborationMessage, type ExecutionToolCall } from "../../../../packages/contracts/src/collaboration.ts";
import type { PermissionService } from "../../../platform/auth/permission-store.ts";
import type { Mastra, } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { E2E_AGENT_ID, MAIN_AGENT_ID, GenerateE2EConversationActionSchema, type E2ERun, type OwnerScope } from "../../../../packages/contracts/src/index.ts";
import { type AgentDelivery, type CollaborationScope, sharedContext, ExecutionInstructionBoundaryError, join } from "../../../../packages/domain/src/collaboration-repository.ts";
import { collaborationRepository, conversationRepository, runRepository, e2eCoordinator, e2eTools, preflightReusableRun, caseHubRepository, sideEffectExecutor, createMastraRuntimeStorage } from "../../runtime.ts";
import { OAuthPrincipalSchema } from "../../../platform/auth/oauth-principal.ts";
import { prepareQaseyRequestContext } from "./service.ts";
import { cancelE2ERun } from "../../workflows/e2e-workflow.ts";

type ConversationTurnExecutor = typeof import("./routes.ts").executeConversationTurn;

function tenantOwner(scope: CollaborationScope): OwnerScope {
  return { applicationId: scope.applicationId, tenantId: scope.tenantId };
}

const terminal = ["succeeded", "failed", "cancelled"];
const labels: Record<string, string> = {
  queued: "已接收任务", preparing_workspace: "正在准备隔离环境", authoring: "正在编写测试", author_running: "正在编写和自检",
  repairing: "正在修复测试", clean_verifying: "正在独立验证", awaiting_qa: "独立验证已通过，等待审核", succeeded: "任务已完成", failed: "执行失败", cancelled: "执行已取消",
};

export async function attachConversationRuns(scope: CollaborationScope): Promise<void> {
  const owner = tenantOwner(scope);
  const [state, turns] = await Promise.all([collaborationRepository.read(scope), conversationRepository.listTurns(owner, scope.subjectId, scope.conversationId)]);
  const ids = [...new Set(turns.flatMap(t => t.linkedRunId ? [t.linkedRunId] : []))].filter(id => !state.runs.some(r => r.runId === id));
  for (const runId of ids) {
    const run = await runRepository.get(owner, runId);
    if (!run || run.sourceSessionId !== scope.conversationId) continue;
    const events = await runRepository.events(owner, runId);
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
  const owner = tenantOwner(scope);
  const state = await collaborationRepository.read(scope);
  for (const link of state.runs) {
    const [run, events] = await Promise.all([runRepository.get(owner, link.runId), runRepository.events(owner, link.runId)]);
    if (!run) continue;
    // Repair pre-upgrade runs from their own persisted traces, without reading model payloads into chat.
    const restoredReceipt = `tools-restored:v2:${run.id}`;
    if (terminal.includes(run.status) && !state.receipts.includes(restoredReceipt)) {
      const traceIds = [...new Set(events.flatMap(event => typeof event.metadata.traceId === "string" ? [event.metadata.traceId] : []))];
      const restored: ExecutionToolCall[] = [];
      if (traceIds.length) {
        const storage = await createMastraRuntimeStorage().getStore("observability");
        for (const traceId of traceIds) {
          const trace = await storage?.getTrace({ traceId });
          for (const span of trace?.spans ?? []) {
            const context = { ...span.metadata, ...span.requestContext };
            const taskId = context.codeTaskId;
            if (typeof taskId !== "string" || !run.codeTaskIds.includes(taskId)) continue;
            const tool = codeTaskActivity({ taskId, cursor: span.spanId, at: span.startedAt.toISOString(), type: "agent.trace.span_ended", message: "", metadata: {
              attemptId: context.attemptId, mastraTraceEvent: { type: "span_ended", exportedSpan: { id: span.spanId, type: span.spanType, name: span.name, entityId: span.entityId, entityName: span.entityName, attributes: span.attributes, errorInfo: span.error || !span.endedAt } },
            } });
            if (tool) restored.push(tool);
          }
        }
      }
      await collaborationRepository.change(scope, current => {
        if (current.receipts.includes(restoredReceipt)) return;
        current.receipts.push(restoredReceipt);
        if (!restored.length) return;
        const id = `activity:${run.id}`;
        const message = current.messages.find(message => message.id === id);
        if (message) {
          message.toolCalls = [...restored.filter(tool => !message.toolCalls?.some(existing => existing.id === tool.id)), ...(message.toolCalls ?? [])];
        } else current.messages.push({ id, authorAgentId: E2E_AGENT_ID, recipientAgentIds: [], role: "assistant", kind: "execution", status: "completed", text: "", createdAt: run.updatedAt, runId: run.id, rootMessageId: link.turnId ?? run.id, toolCalls: restored });
      });
    }
    // Older projections acknowledged completed tasks even when no summary was emitted.
    // Backfill those replies with stable IDs so replay also repairs existing conversations.
    const pending = events.filter(event => !state.receipts.includes(event.id)
      || event.type === "code_task.completed" && !state.messages.some(message => message.id === `analysis:${event.id}`));
    if (!pending.length) continue;
    await collaborationRepository.change(scope, current => {
      for (const event of pending) {
        if (event.type === "code_task.completed" && !current.messages.some(message => message.id === `analysis:${event.id}`)) {
          if (!current.receipts.includes(event.id)) current.receipts.push(event.id);
          const text = executionAnalysis(event.metadata);
          if (text) current.messages.push({ id: `analysis:${event.id}`, authorAgentId: E2E_AGENT_ID, recipientAgentIds: [], role: "assistant", kind: "message", status: "completed", text, createdAt: event.at, runId: run.id, rootMessageId: link.turnId ?? run.id });
          continue;
        }
        if (current.receipts.includes(event.id)) continue;
        current.receipts.push(event.id);
        if (event.type === "code_task.activity") {
          const parsed = ExecutionToolCallSchema.safeParse(event.metadata.activity);
          if (!parsed.success) continue;
          const id: string = `activity:${run.id}`;
          let message: CollaborationMessage | undefined = current.messages.find(message => message.id === id);
          if (!message) {
            message = { id, authorAgentId: E2E_AGENT_ID, recipientAgentIds: [], role: "assistant", kind: "execution", status: "completed", text: "", createdAt: event.at, runId: run.id, rootMessageId: link.turnId ?? run.id, toolCalls: [] };
            current.messages.push(message);
          }
          const tools: ExecutionToolCall[] = message.toolCalls ??= [];
          const existing = tools.findIndex(tool => tool.id === parsed.data.id);
          if (existing < 0) tools.push(parsed.data);
          else if (tools[existing]?.status === "running") tools[existing] = parsed.data;
          continue;
        }
        if (!event.type.startsWith("run.") || event.type === "run.context_frozen") continue;
        const status = event.type.slice(4) === "created" ? "queued" : event.type.slice(4);
        if (!labels[status]) continue;
        let text = labels[status]!;
        if (status === "failed") text += `。${event.message}`;
        current.messages.push({ id: `event:${event.id}`, authorAgentId: E2E_AGENT_ID, recipientAgentIds: [], role: "assistant", kind: "execution", status: status === "failed" ? "failed" : "completed", text, createdAt: event.at, runId: run.id, rootMessageId: link.turnId ?? run.id });
      }
    });
  }
}

// Only user-facing Agent summaries and structured check outcomes enter chat.
// Raw tool output remains in the run details and must never become instructions.
function executionAnalysis(metadata: Record<string, unknown>): string | undefined {
  const summary = typeof metadata.analysisSummary === "string" ? metadata.analysisSummary.trim().slice(0, 8000) : "";
  const checks = Array.isArray(metadata.checks) ? metadata.checks.filter((check): check is { id: string; passed: boolean } => Boolean(check) && typeof check === "object" && typeof check.id === "string" && typeof check.passed === "boolean") : [];
  const names: Record<string, string> = { "repo-install": "依赖准备", "playwright-discovery": "测试发现", playwright: "浏览器测试", typecheck: "类型检查", lint: "代码规范" };
  const failed = checks.filter(check => !check.passed);
  const outcome = checks.length ? `本轮检查：${checks.length - failed.length} 项通过，${failed.length} 项未通过。${failed.length ? `未通过：${failed.map(check => names[check.id] ?? "仓库检查").join("、")}。` : ""}` : "本轮没有可用的检查结果。";
  if (metadata.executionProfileId === "web-e2e-verifier") {
    return `已在独立环境验证测试实现。${outcome}\n\n${metadata.status === "succeeded" ? "这只是自动检查结果，交付状态和人工审核结论以任务后续进度为准。" : "本轮验证未通过，尚不能确认产品行为符合预期；需结合失败结果判断是测试实现、环境还是产品问题。"}`;
  }
  const phase = metadata.executionProfileId === "web-e2e-repair" ? "修复与自检" : "编写与自检";
  const fallback = metadata.status === "cancelled" ? "本轮执行已取消，尚不能确认测试实现完成。"
    : metadata.status === "failed" ? "本轮执行未通过，尚不能确认测试实现完成。"
    : "本轮执行已结束，但未返回文字总结。";
  return `${phase}总结：\n\n${summary || fallback}\n\n${outcome}独立验证结果另行汇报。`;
}

export async function acceptCollaborationMessage(scope: CollaborationScope, input: {
  id: string; text: string; recipients?: string[]; principal: Record<string, unknown>; runId?: string;
}): Promise<string[]> {
  const owner = tenantOwner(scope);
  if (!await conversationRepository.getConversation(owner, scope.subjectId, scope.conversationId)) throw new Error("Conversation not found");
  const [state, turns] = await Promise.all([collaborationRepository.read(scope), conversationRepository.listTurns(owner, scope.subjectId, scope.conversationId)]);
  const legacy = turns.filter(t => !state.messages.some(m => m.turnId === t.id)).slice(-20).map(t => ({ author: MAIN_AGENT_ID, user: t.userMessage, text: t.assistantText }));
  if (input.runId) {
    const target = await runRepository.get(owner, input.runId);
    if (!target || target.applicationId !== scope.applicationId || target.tenantId !== scope.tenantId) throw new Error("Run not found");
  }
  return collaborationRepository.send(scope, { ...input, context: JSON.stringify({ legacy, conversation: JSON.parse(sharedContext(state)) }) }, input.runId ? { authorizedRunId: input.runId } : {});
}

export function toolsForDelivery(mastra: Mastra, scope: CollaborationScope, delivery: AgentDelivery, permissions: PermissionService) {
  const owner = tenantOwner(scope);
  const selectRun = async (id?: string): Promise<E2ERun> => {
    const state = await collaborationRepository.read(scope);
    const ids = state.runs.map(r => r.runId);
    const chosen = id ?? delivery.runId ?? (ids.length === 1 ? ids[0] : undefined);
    if (!chosen) throw new Error("请明确指定 run；存在多个任务时不要猜测。可通过用例查询找到其他会话的已有任务。");
    const run = await runRepository.get(owner, chosen);
    if (!run || run.applicationId !== scope.applicationId || run.tenantId !== scope.tenantId) throw new Error("运行不存在或无权访问。");
    return run;
  };
  return {
    ...(delivery.agentId === E2E_AGENT_ID ? e2eTools() : {}),
    delegate_agent: createTool({ id: "delegate_agent", description: "向当前会话的另一位参与 Agent 发起可见协作。结果会自动回到此会话并唤醒你，不要重复委派或轮询。", inputSchema: z.object({ agentId: z.string(), message: z.string().min(1).max(8000) }), execute: async (input) => {
      await requireDeliveryPermission(permissions, delivery, input.agentId === E2E_AGENT_ID ? "qasey.e2e.execute" : "qasey.agent.execute");
      const key = `${delivery.id}:delegate:${input.agentId}:${input.message}`;
      return { deliveryId: await collaborationRepository.delegate(scope, delivery.id, input.agentId, input.message, key), status: "queued" };
    } }),
    conversation_runs: createTool({ id: "conversation_runs", description: "列出本会话任务，或读取当前租户任意明确指定 E2E run 的状态和证据。不会读取其他会话消息或实现补充。只读。", inputSchema: z.object({ runId: z.string().optional() }), execute: async ({ runId }) => {
      await requireDeliveryPermission(permissions, delivery, "qasey.runs.read");
      const state = await collaborationRepository.read(scope);
      if (runId) { const run = await selectRun(runId); return { run, events: await runRepository.events(owner, run.id), instructions: state.instructions.filter(i => i.runId === run.id) }; }
      return { runs: await Promise.all(state.runs.map(r => runRepository.get(owner, r.runId))), instructions: state.instructions };
    } }),
    update_e2e_execution: createTool({ id: "update_e2e_execution", description: "对精确 E2E run 提交实现补充或停止。步骤、预期、范围变化必须选 review_cases，不能修改冻结用例。已结束或待审任务的实现补充会创建后续 run。", inputSchema: z.object({ runId: z.string().optional(), action: z.enum(["amend", "stop", "review_cases"]), message: z.string().min(1).max(5000) }), execute: async ({ runId, action, message }) => {
      await requireDeliveryPermission(permissions, delivery, "qasey.e2e.execute");
      let run = await selectRun(runId);
      if (action === "review_cases") return { status: "text_review_required", message: "请回到文字用例审核修改并重新批准步骤、预期或范围。当前冻结版本未改动。" };
      const principal = OAuthPrincipalSchema.parse(delivery.principal);
      const context = prepareQaseyRequestContext({ requestId: delivery.id, channel: "api", sessionId: scope.conversationId, chatInput: message, actor: { id: scope.subjectId, tenantId: scope.tenantId }, source: {}, attachments: [] }, new RequestContext());
      context.set("platform-principal", principal);
      context.set("identity", { userId: principal.subjectId, tenantId: principal.tenantId, roles: principal.roles, service: principal.service });
      if (action === "stop") return { run: await cancelE2ERun(mastra, owner, run.id) };
      const previousChangeSet = await caseHubRepository.getChangeSet(owner, run.changeSetId);
      if (!previousChangeSet) throw new Error("Source run case selection not found");
      try { await approvedReusableVersions(caseHubRepository, owner, previousChangeSet.caseVersionIds); }
      catch { throw new Error("The explicitly selected run uses deleted or superseded text versions. Read the case and explicitly select its current approved version; this operation will not silently switch versions or create another text review."); }
      if (run.sourceSessionId !== scope.conversationId && !terminal.includes(run.status) && run.status !== "awaiting_qa") {
        throw new Error("The selected run is still active in another conversation. Wait for it to finish or explicitly stop it before creating a follow-up; no competing run was created.");
      }
      const mailbox = await collaborationRepository.read(scope);
      if (run.sourceSessionId === scope.conversationId && !terminal.includes(run.status) && run.status !== "awaiting_qa" && mailbox.runs.find(r => r.runId === run.id)?.acceptingInstructions !== false) {
        try {
          return { instruction: await collaborationRepository.instruction(scope, run.id, message, delivery.messageId), message: "已接收，将在下一编写或修复节点应用，并重新独立验证。" };
        } catch (error) { if (!(error instanceof ExecutionInstructionBoundaryError)) throw error; }
      }
      if (!terminal.includes(run.status) && run.status !== "awaiting_qa") {
        throw new Error("The active run has closed its instruction window. Wait for completion before creating a follow-up; no competing run was created.");
      }
      {
        const sourceId = run.id;
        const receipt = `followup:${delivery.messageId}:${sourceId}`;
        const state = await collaborationRepository.read(scope);
        const existing = state.instructions.find(i => i.messageId === receipt);
        if (existing) return { run: await runRepository.get(owner, existing.runId), instruction: existing };
        return sideEffectExecutor.execute({
          owner, runId: sourceId, stepId: "conversation-followup", businessKey: receipt,
          request: { sourceId, message },
          operation: async () => {
        const statuses = await caseHubRepository.automationStatuses(owner, previousChangeSet.caseVersionIds);
        if (previousChangeSet.caseVersionIds.some(id => statuses[id] === "generating")) {
          throw new Error("These exact text versions already have an active automation run. Amend that explicit run or wait for completion before creating another follow-up.");
        }
        await preflightReusableRun(owner, run, previousChangeSet);
        const followupChangeSet = await caseHubRepository.createAutomationChangeSet(owner, {
          requirement: previousChangeSet.requirement, caseVersionIds: previousChangeSet.caseVersionIds,
          repository: previousChangeSet.repository, createdBy: scope.subjectId,
          ...(previousChangeSet.baseSha ? { baseSha: previousChangeSet.baseSha } : {}),
          ...(previousChangeSet.environmentSourceSha ? { environmentSourceSha: previousChangeSet.environmentSourceSha } : {}),
        });
        run = await e2eCoordinator.rerun(owner, sourceId, followupChangeSet.id, { sessionId: scope.conversationId, requestId: delivery.id });
        await collaborationRepository.joinRun(scope, run.id);
        const instruction = await collaborationRepository.instruction(scope, run.id, message, receipt);
        const changeSet = await caseHubRepository.getChangeSet(owner, run.changeSetId);
        if (changeSet) await caseHubRepository.updateChangeSet(owner, changeSet.id, changeSet.revision, { status: "verifying", runId: run.id });
        const workflow = await mastra.getWorkflow("qasey-e2e-lifecycle").createRun({ runId: run.id, resourceId: scope.subjectId });
        try { await workflow.startAsync({ inputData: { runId: run.id }, requestContext: context }); }
        catch (error) { await e2eCoordinator.fail(owner, run.id, error); throw error; }
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
  const owner = tenantOwner(scope);
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
    const existingTurn = delivery.turnId ? (await conversationRepository.listTurns(owner, scope.subjectId, scope.conversationId)).find(t => t.id === delivery.turnId) : undefined;
    const started = existingTurn ? { turn: existingTurn } : await conversationRepository.startTurn(owner, scope.subjectId, scope.conversationId, delivery.responseId, message.text || "请继续处理协作结果。");
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
    const completed = (await conversationRepository.listTurns(owner, scope.subjectId, scope.conversationId)).find(t => t.id === started.turn.id)!;
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
