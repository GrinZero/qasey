import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import type { Mastra } from "@mastra/core/mastra";
import { PrismaCaseHubRepository } from "../../packages/domain/src/case-hub-repository.ts";
import type { PermissionService } from "../../src/platform/auth/permission-store.ts";
import { E2E_AGENT_ID, MAIN_AGENT_ID } from "../../packages/contracts/src/index.ts";

vi.mock("../../src/mastra/applications/qasey/routes.ts", () => ({ executeConversationTurn: vi.fn() }));
vi.mock("../../src/mastra/applications/qasey/service.ts", () => ({ prepareQaseyRequestContext: (_context: unknown, requestContext: RequestContext) => requestContext }));
vi.mock("../../src/mastra/workflows/e2e-workflow.ts", () => ({ cancelE2ERun: vi.fn(async (_m, _o, runId) => ({ id: runId, status: "cancelled" })) }));
vi.mock("../../src/mastra/runtime.ts", async () => {
  const { CollaborationRepository } = await import("../../packages/domain/src/collaboration-repository.ts");
  return {
    collaborationRepository: new CollaborationRepository(),
    createMastraRuntimeStorage: vi.fn(() => ({ getStore: vi.fn(async () => ({ getTrace: vi.fn(async () => null) })) })),
    conversationRepository: { getConversation: vi.fn(async () => ({})), listTurns: vi.fn(async () => []) },
    runRepository: { get: vi.fn(), events: vi.fn(async () => []) },
    e2eTools: () => ({}),
    preflightReusableRun: vi.fn(async () => undefined),
    e2eCoordinator: { rerun: vi.fn(), fail: vi.fn() },
    caseHubRepository: { automationStatuses: vi.fn(), listCases: vi.fn(), versionsForCase: vi.fn(), getChangeSet: vi.fn(), createAutomationChangeSet: vi.fn(), updateChangeSet: vi.fn() },
    sideEffectExecutor: { execute: vi.fn(async ({ operation }) => (await operation()).result) },
  };
});
import { collaborationRepository, runRepository, caseHubRepository, e2eCoordinator, createMastraRuntimeStorage } from "../../src/mastra/runtime.ts";
import { acceptCollaborationMessage, projectRunEvents, toolsForDelivery } from "../../src/mastra/applications/qasey/collaboration.ts";
import { cancelE2ERun } from "../../src/mastra/workflows/e2e-workflow.ts";

let serial = 0;
const scope = () => ({ applicationId: "qasey", tenantId: "tenant-public", subjectId: "user-public", conversationId: `conversation-${++serial}` });
const principal = { subjectId: "user-public", tenantId: "tenant-public", roles: ["user"], audience: "admin-ui", service: false };
const allowed = { authorize: vi.fn(async () => true) } as unknown as PermissionService;
const denied = { authorize: vi.fn(async () => false) } as unknown as PermissionService;
const workflow = { startAsync: vi.fn(async () => undefined) };
const mastra = { getWorkflow: vi.fn(() => ({ createRun: vi.fn(async () => workflow) })) } as unknown as Mastra;

async function setup(status = "author_running") {
  const owner = scope();
  await collaborationRepository.joinRun(owner, "run-one");
  await collaborationRepository.send(owner, { id: "user-message", text: "修复测试实现", recipients: [E2E_AGENT_ID], principal, context: "snapshot" });
  const [delivery] = await collaborationRepository.claim(owner);
  const run = { ...owner, id: "run-one", sourceSessionId: owner.conversationId, status, changeSetId: "change-one", artifacts: [] };
  vi.mocked(runRepository.get).mockImplementation(async (_owner, id) => id === "run-one" ? run as never : undefined);
  return { owner, delivery: delivery!, run };
}
const tenantOwner = (value: { applicationId: string; tenantId: string }) => ({ applicationId: value.applicationId, tenantId: value.tenantId });
const executionContext = { requestContext: new RequestContext() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(caseHubRepository.getChangeSet).mockImplementation(async (_o, id) => ({ id, revision: 1, caseVersionIds: ["approved-version"] }) as never);
  vi.mocked(caseHubRepository.automationStatuses).mockResolvedValue({ "approved-version": "none" });
  vi.mocked(caseHubRepository.listCases).mockResolvedValue([{ id: "QASEY-1", activeVersionId: "approved-version" }] as never);
  vi.mocked(caseHubRepository.versionsForCase).mockResolvedValue([{ applicationId: "qasey", tenantId: "tenant-public", id: "approved-version", status: "active" }] as never);
});

describe("conversation E2E control and durable event projection", () => {
  it("passes only tenant ownership into real Prisma Change Set query arguments", async () => {
    const { owner, delivery } = await setup("succeeded");
    const findUnique = vi.fn(async (args: { where: unknown; select: unknown }) => {
      expect(args.where).toEqual({ applicationId_tenantId_id: { ...tenantOwner(owner), id: "change-one" } });
      return null;
    });
    const repository = new PrismaCaseHubRepository({ $connect: async () => undefined, qaseyCaseChangeSetRecord: { findUnique } } as never);
    await repository.init();
    vi.mocked(caseHubRepository.getChangeSet).mockImplementation((scope, id) => repository.getChangeSet(scope, id));
    await expect(toolsForDelivery(mastra, owner, delivery, allowed).update_e2e_execution.execute!({ action: "amend", message: "Fix locator" }, executionContext)).rejects.toThrow("Source run case selection not found");
    expect(findUnique).toHaveBeenCalledOnce();
  });

  it("uses the target agent permission before a mutation", async () => {
    const { owner, delivery } = await setup();
    const tools = toolsForDelivery(mastra, owner, delivery, denied);
    await expect(tools.update_e2e_execution.execute!({ action: "stop", message: "stop", runId: "run-one" }, executionContext)).rejects.toThrow("权限");
    expect(cancelE2ERun).not.toHaveBeenCalled();
  });
  it("asks for an exact run when multiple runs are present, and rejects foreign runs", async () => {
    const { owner, delivery } = await setup(); await collaborationRepository.joinRun(owner, "run-two");
    const tools = toolsForDelivery(mastra, owner, delivery, allowed);
    await expect(tools.update_e2e_execution.execute!({ action: "amend", message: "fix" }, executionContext)).rejects.toThrow("明确指定");
    await expect(tools.conversation_runs.execute!({ runId: "foreign" }, executionContext)).rejects.toThrow("无权访问");
    expect((await collaborationRepository.read(owner)).instructions).toEqual([]);
  });
  it("acknowledges amendments durably and sends explicit cancellation straight to the lifecycle", async () => {
    const { owner, delivery } = await setup();
    const tools = toolsForDelivery(mastra, owner, delivery, allowed);
    await expect(tools.update_e2e_execution.execute!({ action: "amend", message: "修复 locator" }, executionContext)).resolves.toMatchObject({ instruction: { status: "pending" } });
    expect((await collaborationRepository.read(owner)).instructions).toHaveLength(1);
    await tools.update_e2e_execution.execute!({ action: "stop", message: "停止" }, executionContext);
    expect(cancelE2ERun).toHaveBeenCalledWith(mastra, tenantOwner(owner), "run-one");
  });
  it("routes changed case expectations back to text review without altering an execution brief", async () => {
    const { owner, delivery } = await setup();
    const tools = toolsForDelivery(mastra, owner, delivery, allowed);
    await expect(tools.update_e2e_execution.execute!({ action: "review_cases", message: "改变预期" }, executionContext)).resolves.toMatchObject({ status: "text_review_required" });
    expect((await collaborationRepository.read(owner)).instructions).toEqual([]);
    expect(caseHubRepository.updateChangeSet).not.toHaveBeenCalled();
  });
  it("creates an independent follow-up change set and retains the previous result", async () => {
    const { owner, delivery, run } = await setup("succeeded");
    vi.mocked(caseHubRepository.getChangeSet).mockImplementation(async (_o, id) => ({ id, revision: 1, caseVersionIds: ["approved-version"], requirement: { summary: "public requirement" }, repository: { owner: "example", repository: "sample" } }) as never);
    vi.mocked(caseHubRepository.createAutomationChangeSet).mockResolvedValue({ id: "followup-change" } as never);
    vi.mocked(e2eCoordinator.rerun).mockResolvedValue({ ...run, id: "run-followup", changeSetId: "followup-change", status: "queued" } as never);
    const tools = toolsForDelivery(mastra, owner, delivery, allowed);
    await expect(tools.update_e2e_execution.execute!({ action: "amend", message: "修复测试" }, executionContext)).resolves.toMatchObject({ sourceRunId: "run-one", run: { id: "run-followup" } });
    expect(e2eCoordinator.rerun).toHaveBeenCalledWith(tenantOwner(owner), "run-one", "followup-change", { sessionId: owner.conversationId, requestId: delivery.id });
    expect(caseHubRepository.updateChangeSet).toHaveBeenCalledWith(tenantOwner(owner), "followup-change", 1, { status: "verifying", runId: "run-followup" });
    for (const method of [caseHubRepository.getChangeSet, caseHubRepository.listCases, caseHubRepository.versionsForCase, caseHubRepository.automationStatuses, caseHubRepository.createAutomationChangeSet, caseHubRepository.updateChangeSet, e2eCoordinator.rerun, runRepository.get]) {
      for (const call of vi.mocked(method).mock.calls) expect(call[0]).toEqual(tenantOwner(owner));
    }
    expect(run.status).toBe("succeeded");
    expect(workflow.startAsync).toHaveBeenCalledTimes(1);
  });
  it("accepts an explicit same-tenant target from another conversation without joining its history", async () => {
    const owner = scope();
    vi.mocked(runRepository.get).mockResolvedValue({ ...owner, id: "external-run", sourceSessionId: "external-conversation" } as never);
    await acceptCollaborationMessage(owner, { id: "cross-message", text: "Improve existing automation", principal, runId: "external-run" });
    const state = await collaborationRepository.read(owner);
    expect(state.runs).toEqual([]);
    expect(state.deliveries).toMatchObject([{ runId: "external-run", agentId: MAIN_AGENT_ID }]);
    expect(state.messages[0]).toMatchObject({ text: "Improve existing automation" });
    vi.mocked(runRepository.get).mockResolvedValue({ ...owner, tenantId: "foreign", id: "foreign-run" } as never);
    await expect(acceptCollaborationMessage(owner, { id: "foreign-message", text: "Edit", principal, runId: "foreign-run" })).rejects.toThrow("not found");
  });

  it("rejects superseded text without changing the requested version or creating a review", async () => {
    const { owner, delivery } = await setup();
    vi.mocked(caseHubRepository.listCases).mockResolvedValue([{ id: "QASEY-1", activeVersionId: "current-v2" }] as never);
    await expect(toolsForDelivery(mastra, owner, delivery, allowed).update_e2e_execution.execute!({ action: "amend", message: "Fix locator" }, executionContext)).rejects.toThrow("superseded");
    expect(caseHubRepository.createAutomationChangeSet).not.toHaveBeenCalled();
    expect((await collaborationRepository.read(owner)).instructions).toEqual([]);
  });

  it("does not fork a competing active run from another conversation", async () => {
    const { owner, delivery, run } = await setup();
    vi.mocked(runRepository.get).mockResolvedValue({ ...run, sourceSessionId: "other-conversation" } as never);
    await expect(toolsForDelivery(mastra, owner, delivery, allowed).update_e2e_execution.execute!({ action: "amend", message: "Fix locator" }, executionContext)).rejects.toThrow("still active");
    expect(caseHubRepository.createAutomationChangeSet).not.toHaveBeenCalled();
    expect(e2eCoordinator.rerun).not.toHaveBeenCalled();
  });

  it("does not fork an old completed run when those versions already have a newer active run", async () => {
    const { owner, delivery } = await setup("succeeded");
    vi.mocked(caseHubRepository.automationStatuses).mockResolvedValue({ "approved-version": "generating" });
    await expect(toolsForDelivery(mastra, owner, delivery, allowed).update_e2e_execution.execute!({ action: "amend", message: "Fix locator" }, executionContext)).rejects.toThrow("already have an active");
    expect(caseHubRepository.createAutomationChangeSet).not.toHaveBeenCalled();
    expect(e2eCoordinator.rerun).not.toHaveBeenCalled();
  });

  it("amends an explicitly selected tenant run from another conversation without copying its private messages", async () => {
    const { owner, delivery, run } = await setup("author_running");
    const foreignConversationRun = { ...run, status: "succeeded", id: "other-conversation-run", sourceSessionId: "other-conversation" };
    vi.mocked(runRepository.get).mockImplementation(async (_o, id) => id === foreignConversationRun.id ? foreignConversationRun as never : run as never);
    vi.mocked(caseHubRepository.getChangeSet).mockImplementation(async (_o, id) => ({ id, revision: 1, caseVersionIds: ["approved-version"], requirement: { summary: "public case requirement" }, repository: { owner: "example", repository: "sample" } }) as never);
    vi.mocked(caseHubRepository.createAutomationChangeSet).mockResolvedValue({ id: "followup-change" } as never);
    vi.mocked(e2eCoordinator.rerun).mockResolvedValue({ ...run, id: "new-current-run", changeSetId: "followup-change", status: "queued" } as never);
    const tools = toolsForDelivery(mastra, owner, delivery, allowed);
    await expect(tools.update_e2e_execution.execute!({ runId: foreignConversationRun.id, action: "amend", message: "Improve locator reliability" }, executionContext)).resolves.toMatchObject({ sourceRunId: foreignConversationRun.id, run: { id: "new-current-run", sourceSessionId: owner.conversationId } });
    expect(e2eCoordinator.rerun).toHaveBeenCalledWith(tenantOwner(owner), foreignConversationRun.id, "followup-change", { sessionId: owner.conversationId, requestId: delivery.id });
    const state = await collaborationRepository.read(owner);
    expect(state.runs.map(link => link.runId)).toContain("new-current-run");
    expect(state.runs.map(link => link.runId)).not.toContain(foreignConversationRun.id);
    expect(state.instructions).toMatchObject([{ runId: "new-current-run", text: "Improve locator reliability" }]);
  });

  it("delivers analysis and check outcomes once without projecting raw logs or artifact links", async () => {
    const { owner, run } = await setup("clean_verifying");
    const at = new Date().toISOString();
    vi.mocked(runRepository.events).mockResolvedValue([
      { id: "author", runId: run.id, at, type: "code_task.completed", message: "internal log", metadata: { executionProfileId: "web-e2e-author", status: "succeeded", analysisSummary: "复用了页面对象，并覆盖短视口滚动。", checks: [{ id: "playwright-discovery", passed: true }] } },
      { id: "verifier", runId: run.id, at, type: "code_task.completed", message: "raw stack trace", metadata: { executionProfileId: "web-e2e-verifier", status: "failed", checks: [{ id: "repo-install", passed: true }, { id: "playwright", passed: false }] } },
      { id: "awaiting", runId: run.id, at, type: "run.awaiting_qa", message: "ready", metadata: {} },
    ]);
    vi.mocked(runRepository.get).mockResolvedValue({ ...run, artifacts: [{ id: "trace", kind: "trace", name: "trace.zip" }] } as never);
    await Promise.all([projectRunEvents(owner), projectRunEvents(owner)]);
    await projectRunEvents(owner);
    const state = await collaborationRepository.read(owner);
    const analysis = state.messages.filter(message => message.id.startsWith("analysis:"));
    expect(analysis).toHaveLength(2);
    expect(analysis[0]).toMatchObject({ kind: "message", authorAgentId: E2E_AGENT_ID, runId: run.id });
    expect(analysis[0]!.text).toContain("复用了页面对象");
    expect(analysis[0]!.text).toContain("独立验证结果另行汇报");
    expect(analysis[1]!.text).toContain("1 项通过，1 项未通过");
    expect(analysis[1]!.text).toContain("浏览器测试");
    expect(JSON.stringify(state.messages)).not.toMatch(/raw stack trace|internal log|trace.zip|查看运行与证据/);
    expect(state.deliveries).toHaveLength(1);
  });

  it("restores only the run's own historical tool spans", async () => {
    const { owner, run } = await setup("failed");
    // Older projections acknowledged the trace even though decorated span names
    // caused every native tool to be discarded. The new projection must retry.
    await collaborationRepository.change(owner, state => { state.receipts.push(`tools-restored:${run.id}`); });
    const at = new Date("2026-09-06T00:00:00.000Z");
    vi.mocked(runRepository.get).mockResolvedValue({ ...run, updatedAt: at.toISOString(), codeTaskIds: ["run-one:author:0"] } as never);
    vi.mocked(runRepository.events).mockResolvedValue([{ id: "historical-task", runId: run.id, at: at.toISOString(), type: "code_task.submitted", message: "", metadata: { traceId: "public-trace" } }]);
    const getTrace = vi.fn(async () => ({ spans: [
      { spanId: "public-span", spanType: "tool_call", name: "tool: 'mastra_workspace_read_file'", entityId: "mastra_workspace_read_file", entityName: "mastra_workspace_read_file", attributes: { toolType: "tool", toolCallId: "public-call" }, startedAt: at, endedAt: at, metadata: { codeTaskId: "run-one:author:0" }, input: "private payload" },
      { spanId: "foreign-span", spanType: "tool_call", name: "foreign_tool", startedAt: at, endedAt: at, metadata: { codeTaskId: "other-run:author:0" } },
    ] }));
    vi.mocked(createMastraRuntimeStorage).mockReturnValue({ getStore: async () => ({ getTrace }) } as never);
    await projectRunEvents(owner);
    await projectRunEvents(owner);
    const message = (await collaborationRepository.read(owner)).messages.find(message => message.id === "activity:run-one");
    expect(message?.toolCalls).toEqual([expect.objectContaining({ name: "mastra_workspace_read_file", status: "completed" })]);
    expect(JSON.stringify(message)).not.toMatch(/private payload|foreign_tool/);
    expect(getTrace).toHaveBeenCalledTimes(1);
  });

  it("projects tool activity as durable E2E message parts and never regresses a completed tool on replay", async () => {
    const { owner, run } = await setup();
    const at = new Date().toISOString();
    const activity = { id: "call-one", name: "mastra_workspace_read_file", title: "读取文件", status: "running" };
    vi.mocked(runRepository.events).mockResolvedValue([
      { id: "tool-start", runId: run.id, at, type: "code_task.activity", message: "ignored raw log", metadata: { activity } },
      { id: "tool-end", runId: run.id, at, type: "code_task.activity", message: "ignored raw log", metadata: { activity: { ...activity, status: "completed" } } },
      { id: "tool-late-start", runId: run.id, at, type: "code_task.activity", message: "ignored raw log", metadata: { activity } },
    ]);
    await Promise.all([projectRunEvents(owner), projectRunEvents(owner)]);
    const state = await collaborationRepository.read(owner);
    const activityMessages = state.messages.filter(message => message.id.startsWith("activity:"));
    expect(activityMessages).toHaveLength(1);
    expect(activityMessages[0]!.toolCalls).toEqual([{ ...activity, status: "completed" }]);
    const { collaborationUIMessages } = await import("../../src/mastra/applications/qasey/collaboration-view.ts");
    expect(collaborationUIMessages(state, [], new Map(), owner.conversationId).find(message => message.id.startsWith("activity:"))?.parts).toEqual([
      expect.objectContaining({ type: "dynamic-tool", toolName: activity.name, state: "output-available" }),
    ]);
  });

  it.each(["succeeded", "failed", "cancelled"])("backfills a missing %s author reply once even after its event was acknowledged", async status => {
    const { owner, run } = await setup();
    await collaborationRepository.change(owner, current => { current.receipts.push("missing-summary"); });
    vi.mocked(runRepository.events).mockResolvedValue([{ id: "missing-summary", runId: run.id, at: new Date().toISOString(), type: "code_task.completed", message: "raw private log", metadata: { executionProfileId: "web-e2e-author", status, checks: [{ id: "playwright", passed: status === "succeeded" }] } }]);
    await Promise.all([projectRunEvents(owner), projectRunEvents(owner)]);
    await projectRunEvents(owner);
    const state = await collaborationRepository.read(owner);
    const replies = state.messages.filter(message => message.id === "analysis:missing-summary");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ authorAgentId: E2E_AGENT_ID, kind: "message", runId: run.id });
    expect(replies[0]!.text).toContain(status === "succeeded" ? "未返回文字总结" : status === "failed" ? "本轮执行未通过" : "本轮执行已取消");
    expect(replies[0]!.text).toContain(status === "succeeded" ? "1 项通过" : "1 项未通过");
    expect(replies[0]!.text).not.toContain("raw private log");
    expect(state.receipts.filter(id => id === "missing-summary")).toHaveLength(1);
  });

  it("projects background failure after the chat has finished and deduplicates replay across workers", async () => {
    const { owner, delivery, run } = await setup("failed");
    await collaborationRepository.finish(owner, delivery, "已启动");
    vi.mocked(runRepository.get).mockResolvedValue({ ...run, error: "locator failed" } as never);
    vi.mocked(runRepository.events).mockResolvedValue([{ id: "event-public-failure", runId: run.id, at: new Date().toISOString(), type: "run.failed", message: "locator failed", metadata: {} }]);
    await Promise.all([projectRunEvents(owner), projectRunEvents(owner)]);
    const state = await collaborationRepository.read(owner);
    expect(state.messages.filter(m => m.id === "event:event-public-failure")).toMatchObject([{ authorAgentId: E2E_AGENT_ID, kind: "execution", status: "failed" }]);
    expect(state.messages.find(m => m.id === "event:event-public-failure")!.text).toContain("locator failed");
    expect(state.deliveries[0]!.status).toBe("completed");
  });
});
