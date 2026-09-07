import { describe, expect, it, vi } from "vitest";
import type { E2ERun } from "../../packages/contracts/src/index.ts";
import { conversationRunFromToolResult } from "../../src/mastra/applications/qasey/conversation-run-links.ts";

const owner = { applicationId: "qasey", tenantId: "public-test" };
const conversationId = "public-conversation";
const run = { ...owner, id: "public-run", sourceSessionId: conversationId } as E2ERun;
const createTools = ["case_hub_start_e2e", "caseHubStartE2E"];
const rerunTools = ["case_hub_rerun_results", "caseHubRerunResults"];

function setup() {
  const repository = { get: vi.fn(async () => run as E2ERun | undefined) };
  return { repository, resolve: (event: { toolName: string; result: unknown; args?: unknown; isError?: boolean }) =>
    conversationRunFromToolResult({ ...event, owner, conversationId, repository }) };
}

describe("trusted conversation run links", () => {
  it.each([...createTools, ...rerunTools])("links the persisted run returned by %s", async toolName => {
    const { resolve, repository } = setup();
    await expect(resolve({ toolName, result: createTools.includes(toolName) ? { run } : run })).resolves.toBe(run.id);
    expect(repository.get).toHaveBeenCalledWith(owner, run.id);
  });

  it.each([{ run }, { result: { run }, externalRef: run.id }])("links amendment followups and idempotent retries: %j", async result => {
    const { resolve } = setup();
    await expect(resolve({ toolName: "update_e2e_execution", args: { action: "amend" }, result })).resolves.toBe(run.id);
  });

  it.each(["conversation_runs", "e2e_get_run", "e2eGetRun", "case_hub_get_change_set", "unknown_tool"])("rejects read-only or unknown tool %s even with plausible run data", async toolName => {
    const { resolve, repository } = setup();
    await expect(resolve({ toolName, result: { ...run, run } })).resolves.toBeUndefined();
    expect(repository.get).not.toHaveBeenCalled();
  });

  it.each([
    { toolName: "caseHubRerunResults", result: run, isError: true },
    { toolName: "case_hub_start_e2e", result: { run, success: false } },
    { toolName: "caseHubRerunResults", result: { ...run, error: "workflow failed" } },
    { toolName: "update_e2e_execution", args: { action: "stop" }, result: { run } },
    { toolName: "update_e2e_execution", args: { action: "review_cases" }, result: { run } },
    { toolName: "update_e2e_execution", args: { action: "amend" }, result: { instruction: { runId: run.id } } },
    { toolName: "case_hub_start_e2e", result: { runId: run.id } },
    { toolName: "caseHubRerunResults", result: null },
  ])("ignores failed and non-creating results: %j", async event => {
    const { resolve, repository } = setup();
    await expect(resolve(event)).resolves.toBeUndefined();
    expect(repository.get).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { ...run, sourceSessionId: "another-conversation" },
    { ...run, tenantId: "another-tenant" },
    { ...run, applicationId: "another-application" },
    { ...run, id: "another-run" },
  ])("rejects missing or foreign persisted runs despite claimed ownership: %j", async persisted => {
    const { resolve, repository } = setup();
    repository.get.mockResolvedValue(persisted);
    await expect(resolve({ toolName: "caseHubRerunResults", result: run })).resolves.toBeUndefined();
  });
});
