import type { MastraLanguageModel } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import type { Workspace } from "@mastra/core/workspace";
import { describe, expect, it, vi } from "vitest";
import { qaseyE2EAuthorAgent } from "../../src/mastra/agents/qasey-e2e-author/agent.ts";
import {
  QASEY_E2E_AUTHOR_ID,
  qaseyE2EAuthorConfig,
} from "../../src/mastra/agents/qasey-e2e-author/config.ts";
import instructions from "../../src/mastra/agents/qasey-e2e-author/instructions.ts";
import { RequirePassingE2ECandidateValidation } from "../../src/mastra/agents/qasey-e2e-author/processors.ts";
import {
  bindE2EAuthorRuntime,
  isE2EAuthorStudioRequest,
  type E2EAuthorRuntimeBindings,
} from "../../src/mastra/agents/qasey-e2e-author/runtime-bindings.ts";
import validateE2ECandidate from "../../src/mastra/agents/qasey-e2e-author/tools/validate-e2e-candidate.ts";

describe("qasey-e2e-author", () => {
  it("is a first-class preassembled Agent with dynamic isolated runtime bindings", async () => {
    const requestContext = new RequestContext();
    const runtime = bindings();
    const release = bindE2EAuthorRuntime(requestContext, runtime);
    try {
      const modelResolver = qaseyE2EAuthorConfig.model as unknown as (input: { requestContext: RequestContext }) => unknown;
      const workspaceResolver = qaseyE2EAuthorConfig.workspace as unknown as (input: { requestContext: RequestContext }) => unknown;
      const instructionResolver = instructions as unknown as (input: { requestContext: RequestContext }) => unknown;

      expect(qaseyE2EAuthorAgent.id).toBe(QASEY_E2E_AUTHOR_ID);
      expect(await modelResolver({ requestContext })).toBe(runtime.model);
      expect(await workspaceResolver({ requestContext })).toBe(runtime.workspace);
      expect(await instructionResolver({ requestContext })).toEqual(expect.arrayContaining([
        expect.stringContaining("Playwright E2E 编写 Agent"),
        expect.stringContaining("冻结的可写路径：e2e"),
        expect.stringContaining("Step 01 · <操作>"),
      ]));
    } finally {
      release();
    }
  });

  it("owns candidate validation as a tool and rejects completion until it passes", async () => {
    const requestContext = new RequestContext();
    const runtime = bindings();
    const release = bindE2EAuthorRuntime(requestContext, runtime);
    try {
      await validateE2ECandidate.execute?.({}, { requestContext } as never);
      expect(runtime.validateCandidate).toHaveBeenCalledTimes(1);
      expect(runtime.validation).toMatchObject({ calls: 1, lastResult: { passed: true } });

      const processor = new RequirePassingE2ECandidateValidation();
      const messages: never[] = [];
      expect(processor.processOutputResult({ requestContext, messages, abort: vi.fn() } as never)).toBe(messages);
    } finally {
      release();
    }
  });

  it("answers addressed conversation messages without requiring a code validation or a writable workspace", async () => {
    const requestContext = new RequestContext();
    requestContext.set("qasey-conversation-agent", "qasey-e2e-author");
    const modelResolver = qaseyE2EAuthorConfig.model as unknown as (input: { requestContext: RequestContext }) => unknown;
    const workspaceResolver = qaseyE2EAuthorConfig.workspace as unknown as (input: { requestContext: RequestContext; mastra: { getWorkspace(): unknown } }) => unknown;
    const instructionResolver = instructions as unknown as (input: { requestContext: RequestContext }) => unknown;
    expect(await modelResolver({ requestContext })).toBeTruthy();
    expect(await workspaceResolver({ requestContext, mastra: { getWorkspace: () => ({}) } })).toBeUndefined();
    expect(await instructionResolver({ requestContext })).toEqual(expect.arrayContaining([expect.stringContaining("以自己的身份回复")]));
    const abort = vi.fn();
    new RequirePassingE2ECandidateValidation().processOutputResult({ requestContext, messages: [], abort } as never);
    expect(abort).not.toHaveBeenCalled();
  });

  it("fails closed when invoked outside an isolated CodeTask binding", async () => {
    const requestContext = new RequestContext();
    const modelResolver = qaseyE2EAuthorConfig.model as unknown as (input: { requestContext: RequestContext }) => unknown;

    await expect(Promise.resolve().then(() => modelResolver({ requestContext })))
      .rejects.toThrow(/internal to an isolated E2E CodeTask/u);
  });

  it("is fully discoverable and directly usable for every Studio agent path", async () => {
    const requestContext = new RequestContext();
    requestContext.set("ingressSource", "mastra-studio");
    const modelResolver = qaseyE2EAuthorConfig.model as unknown as (input: { requestContext: RequestContext }) => unknown;
    const studioWorkspace = { id: "studio-workspace" } as Workspace;
    const workspaceResolver = qaseyE2EAuthorConfig.workspace as unknown as (input: {
      requestContext: RequestContext;
      mastra: { getWorkspace(): Workspace };
    }) => unknown;
    const instructionResolver = instructions as unknown as (input: { requestContext: RequestContext }) => unknown;
    const processor = new RequirePassingE2ECandidateValidation();
    const messages: never[] = [];

    for (const action of ["list", "read", "execute"] as const) {
      requestContext.set("platform-resource-action", action);
      expect(isE2EAuthorStudioRequest(requestContext)).toBe(true);
      expect(await modelResolver({ requestContext })).toMatchObject({ modelId: expect.any(String) });
      expect(await workspaceResolver({
        requestContext,
        mastra: { getWorkspace: () => studioWorkspace },
      })).toBe(studioWorkspace);
      expect(await instructionResolver({ requestContext })).toEqual(expect.arrayContaining([
        expect.stringContaining("Mastra Studio 中直接运行"),
      ]));
      expect(processor.processOutputResult({ requestContext, messages, abort: vi.fn() } as never)).toBe(messages);
    }

    expect(await validateE2ECandidate.execute?.({}, { requestContext } as never)).toMatchObject({
      passed: true,
      summary: expect.stringContaining("Direct Studio session"),
    });
    expect(qaseyE2EAuthorConfig.metadata).not.toHaveProperty("visibility", "internal");
  });

  it("uses a bounded retry tripwire when the Agent tries to finish without validation", () => {
    const requestContext = new RequestContext();
    const runtime = bindings();
    const release = bindE2EAuthorRuntime(requestContext, runtime);
    try {
      const abort = vi.fn(() => { throw new Error("processor retry"); });
      const processor = new RequirePassingE2ECandidateValidation();

      expect(() => processor.processOutputResult({ requestContext, messages: [], abort } as never))
        .toThrow("processor retry");
      expect(abort).toHaveBeenCalledWith(
        expect.stringContaining("validate-e2e-candidate"),
        { retry: true },
      );
      expect(qaseyE2EAuthorConfig.maxProcessorRetries).toBe(2);
    } finally {
      release();
    }
  });
});

function bindings(): E2EAuthorRuntimeBindings {
  return {
    model: { modelId: "test-model" } as unknown as MastraLanguageModel,
    workspace: { id: "test-workspace" } as Workspace,
    profileId: "web-e2e-author",
    writablePaths: ["e2e"],
    validateCandidate: vi.fn(async () => ({ passed: true, summary: "passed", changedPaths: ["e2e/a.spec.ts"] })),
    validation: { calls: 0 },
  };
}
