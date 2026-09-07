import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/mastra/applications/qasey/collaboration.ts", () => ({ acceptCollaborationMessage: vi.fn(), attachConversationRuns: vi.fn() }));
vi.mock("../../src/mastra/workflows/e2e-workflow.ts", () => ({ cancelE2ERun: vi.fn(), dispatchE2ERepair: vi.fn(), rerunE2E: vi.fn(), resumeE2EWithVerdict: vi.fn() }));
vi.mock("../../src/mastra/applications/qasey/service.ts", () => ({ executeQasey: vi.fn() }));
vi.mock("../../src/mastra/runtime.ts", () => ({
  config: { NODE_ENV: "test" },
  conversationRepository: { appendEvent: vi.fn(async () => undefined) },
  runRepository: { get: vi.fn() },
}));

import { executeConversationTurn } from "../../src/mastra/applications/qasey/routes.ts";
import { executeQasey } from "../../src/mastra/applications/qasey/service.ts";
import { conversationRepository, runRepository } from "../../src/mastra/runtime.ts";

const owner = { applicationId: "qasey", tenantId: "public-test" };
const conversationId = "public-conversation";
const principal = { subjectId: "public-user", tenantId: owner.tenantId, roles: ["user"], audience: "admin-ui" as const, service: false };

beforeEach(() => { vi.clearAllMocks(); });

describe("conversation turn run attachment", () => {
  it("persists rerun and followup links and notifies collaboration once per run", async () => {
    const runs = ["original", "rerun", "followup"].map(id => ({ ...owner, id, sourceSessionId: conversationId }));
    vi.mocked(runRepository.get).mockImplementation(async (_owner, id) => runs.find(run => run.id === id) as never);
    vi.mocked(executeQasey).mockImplementation(async (_mastra, _context, options) => {
      const results = [
        { toolName: "caseHubStartE2E", result: { run: runs[0] } },
        { toolName: "caseHubRerunResults", result: runs[1] },
        { toolName: "update_e2e_execution", args: { action: "amend" }, result: { result: { run: runs[2] } } },
        { toolName: "case_hub_rerun_results", result: runs[1] },
        { toolName: "conversation_runs", result: { run: { ...runs[0], id: "read-only" } } },
        { toolName: "caseHubRerunResults", result: { ...runs[0], id: "failed" }, isError: true },
      ];
      for (const [index, result] of results.entries()) {
        await options?.events?.onAgentRuntimeEvent?.({ type: "tool-result", runId: "public-agent-run", step: index, toolCallId: `call-${index}`, args: {}, isError: false, ...result });
      }
      return { text: "Queued" } as never;
    });
    const onLinkedRun = vi.fn(async () => undefined);
    await executeConversationTurn({ mastra: {} as never, owner, principal, conversationId, turnId: "public-turn", message: "Retry E2E", onLinkedRun });
    const links = vi.mocked(conversationRepository.appendEvent).mock.calls.filter(call => call[4] === "run.linked");
    expect(links.map(call => call[5])).toEqual(runs.map(run => ({ runId: run.id })));
    expect(onLinkedRun.mock.calls).toEqual(runs.map(run => [run.id]));
    expect(vi.mocked(conversationRepository.appendEvent).mock.calls.at(-1)?.[4]).toBe("completed");
  });
});
