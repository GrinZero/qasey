import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import type { Mastra } from "@mastra/core/mastra";
import type { PermissionService } from "../../src/platform/auth/permission-store.ts";
import { E2E_AGENT_ID, MAIN_AGENT_ID } from "../../packages/contracts/src/index.ts";

vi.mock("../../src/mastra/applications/qasey/routes.ts", () => ({ executeConversationTurn: vi.fn() }));
vi.mock("../../src/mastra/applications/qasey/service.ts", () => ({ prepareQaseyRequestContext: (_context: unknown, requestContext: RequestContext) => requestContext }));
vi.mock("../../src/mastra/workflows/e2e-workflow.ts", () => ({ cancelE2ERun: vi.fn(async (_m, _o, runId) => ({ id: runId, status: "cancelled" })) }));
vi.mock("../../src/mastra/runtime.ts", async () => {
  const { CollaborationRepository } = await import("../../packages/domain/src/collaboration-repository.ts");
  return {
    collaborationRepository: new CollaborationRepository(),
    conversationRepository: { getConversation: vi.fn(async () => ({})), listTurns: vi.fn(async () => []) },
    runRepository: { get: vi.fn(), events: vi.fn(async () => []) },
    e2eCoordinator: { rerun: vi.fn(), fail: vi.fn() },
    caseHubRepository: { getChangeSet: vi.fn(), createAutomationChangeSet: vi.fn(), updateChangeSet: vi.fn() },
    sideEffectExecutor: { execute: vi.fn(async ({ operation }) => (await operation()).result) },
  };
});
import { collaborationRepository, runRepository, caseHubRepository, e2eCoordinator } from "../../src/mastra/runtime.ts";
import { projectRunEvents, toolsForDelivery } from "../../src/mastra/applications/qasey/collaboration.ts";
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
const executionContext = { requestContext: new RequestContext() } as never;

beforeEach(() => { vi.clearAllMocks(); });

describe("conversation E2E control and durable event projection", () => {
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
    await expect(tools.conversation_runs.execute!({ runId: "foreign" }, executionContext)).rejects.toThrow("明确指定");
    expect((await collaborationRepository.read(owner)).instructions).toEqual([]);
  });
  it("acknowledges amendments durably and sends explicit cancellation straight to the lifecycle", async () => {
    const { owner, delivery } = await setup();
    const tools = toolsForDelivery(mastra, owner, delivery, allowed);
    await expect(tools.update_e2e_execution.execute!({ action: "amend", message: "修复 locator" }, executionContext)).resolves.toMatchObject({ instruction: { status: "pending" } });
    expect((await collaborationRepository.read(owner)).instructions).toHaveLength(1);
    await tools.update_e2e_execution.execute!({ action: "stop", message: "停止" }, executionContext);
    expect(cancelE2ERun).toHaveBeenCalledWith(mastra, owner, "run-one");
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
    expect(e2eCoordinator.rerun).toHaveBeenCalledWith(owner, "run-one", "followup-change");
    expect(caseHubRepository.updateChangeSet).toHaveBeenCalledWith(owner, "followup-change", 1, { status: "verifying", runId: "run-followup" });
    expect(run.status).toBe("succeeded");
    expect(workflow.startAsync).toHaveBeenCalledTimes(1);
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
