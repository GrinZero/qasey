import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it } from "vitest";
import type { E2ERun, OwnerScope } from "../../packages/contracts/src/index.ts";
import { InMemoryRunRepository } from "../../packages/domain/src/run-repository.ts";
import { freezeE2EContext } from "../../packages/domain/src/e2e-context.ts";
import { applyTrustedContext } from "../../src/platform/context/identity-resolver.ts";
import { conversationScope } from "../../src/platform/context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../../src/platform/context/schema.ts";

describe("trusted context and ownership", () => {
  it("overwrites all request-controlled ownership values", () => {
    const context = new RequestContext();
    for (const key of ["applicationId", "identity", MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY]) context.set(key, "spoofed");
    applyTrustedContext(context, {
      requestId: "request-1", applicationId: "alpha", channel: "api", ingressSource: "oauth",
      identity: { userId: "user-1", tenantId: "tenant-1", roles: ["user"], service: false }, sessionId: "session-1",
      [MASTRA_RESOURCE_ID_KEY]: "alpha:tenant-1:user-1", [MASTRA_THREAD_ID_KEY]: "alpha:tenant-1:private:thread-1",
    });
    expect(context.get("applicationId")).toBe("alpha");
    expect(context.get("identity")).toMatchObject({ tenantId: "tenant-1", roles: ["user"] });
    expect(context.get(MASTRA_RESOURCE_ID_KEY)).toBe("alpha:tenant-1:user-1");
  });

  it("removes an untrusted thread when trusted ingress intentionally leaves it unset", () => {
    const context = new RequestContext();
    context.set(MASTRA_THREAD_ID_KEY, "spoofed-thread");

    applyTrustedContext(context, {
      requestId: "request-2", applicationId: "alpha", channel: "api", ingressSource: "oauth",
      identity: { userId: "user-1", tenantId: "tenant-1", roles: ["user"], service: false }, sessionId: "session-2",
      [MASTRA_RESOURCE_ID_KEY]: "alpha:tenant-1:user-1",
    });

    expect(context.has(MASTRA_THREAD_ID_KEY)).toBe(false);
  });

  it("separates private and shared memory ownership", () => {
    const base = { applicationId: "alpha", tenantId: "tenant", userId: "user", conversationId: "channel", externalThreadId: "thread" };
    expect(conversationScope({ ...base, kind: "private" })).toEqual({
      resourceId: "alpha:tenant:user", threadId: "alpha:tenant:private:thread",
    });
    expect(conversationScope({ ...base, kind: "shared" })).toEqual({
      resourceId: "alpha:tenant:channel", threadId: "alpha:tenant:shared:thread",
    });
  });

  it("cannot read or mutate a run through another tenant or application", async () => {
    const repository = new InMemoryRunRepository();
    const owner: OwnerScope = { applicationId: "qasey", tenantId: "tenant-a" };
    const run = testRun(owner, "same-id");
    await repository.create(owner, run);
    await expect(repository.get({ ...owner, tenantId: "tenant-b" }, run.id)).resolves.toBeUndefined();
    await expect(repository.get({ ...owner, applicationId: "other" }, run.id)).resolves.toBeUndefined();
    await expect(repository.list({ ...owner, tenantId: "tenant-b" })).resolves.toEqual([]);
    await expect(repository.list(owner)).resolves.toEqual([run]);
    await expect(repository.update({ ...owner, tenantId: "tenant-b" }, run.id, { status: "failed" })).rejects.toThrow(/not found/u);
    await expect(repository.addEvent({ ...owner, applicationId: "other" }, run.id, "x", "x")).rejects.toThrow(/not found/u);
  });
});

function testRun(owner: OwnerScope, id: string): E2ERun {
  const now = new Date().toISOString();
  const contextSnapshot = freezeE2EContext({
    goal: "test", requirementSummary: "test", inScope: [], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [],
    criticalFlows: [], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [], blockingQuestions: [], evidenceRefs: [],
  }, { sessionId: "session", threadId: "thread", taskRunId: "task", requestId: "request", resourceId: "test" });
  return {
    ...owner, id, requestId: "request", sourceSessionId: "session", status: "queued", platform: "web", framework: "playwright",
    repository: { owner: "o", repository: "r", cloneUrl: "https://example.test/r.git", baseRef: "main", allowedPaths: ["tests"], skillsPaths: [] }, sourceCaseIds: ["case"],
    contextSnapshot, caseSnapshot: [], amendments: [], codeTaskIds: [], artifacts: [], createdAt: now, updatedAt: now,
  };
}
