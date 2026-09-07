import { Agent, MessageList } from "@mastra/core/agent";
import { InMemoryStore } from "@mastra/core/storage";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { Memory } from "@mastra/memory";
import { describe, expect, it, vi } from "vitest";
import { qaseyMemoryOptions } from "../../src/mastra/agents/qasey-main/memory.ts";
import {
  resolveUserMemoryScope, UserMemoryProcessor, UserMemoryService, type UserMemoryLock,
} from "../../src/mastra/applications/qasey/user-memory.ts";
import { conversationScope } from "../../src/platform/context/conversation-scope.ts";
import * as runtime from "../../src/mastra/agents/qasey-main/user-memory-runtime.ts";
import readTool from "../../src/mastra/agents/qasey-main/tools/read_user_memory.ts";
import updateTool from "../../src/mastra/agents/qasey-main/tools/update_user_memory.ts";

function context(userId = "alice", tenantId = "public-fixture", threadId = "task-a") {
  const ctx = new RequestContext();
  const scope = conversationScope({ applicationId: "qasey", tenantId, userId, conversationId: threadId, externalThreadId: threadId, kind: "private" });
  ctx.set("identity", { userId, tenantId, roles: ["user"], service: false });
  ctx.set("applicationId", "qasey");
  ctx.set("channel", "api");
  ctx.set("sessionId", threadId);
  ctx.set(MASTRA_RESOURCE_ID_KEY, scope.resourceId);
  ctx.set(MASTRA_THREAD_ID_KEY, scope.threadId);
  return ctx;
}

function fixture() {
  const memory = new Memory({ storage: new InMemoryStore(), options: qaseyMemoryOptions });
  const locks = new Map<string, Promise<unknown>>();
  const lock: UserMemoryLock = async (key, work) => {
    const pending = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    locks.set(key, pending);
    return pending;
  };
  return { memory, service: new UserMemoryService(memory, lock), secondService: new UserMemoryService(memory, lock) };
}

describe("Qasey user memory", () => {
  it("shares user preferences across threads while preserving both thread scratchpads", async () => {
    const { memory, service } = fixture();
    const first = context();
    const second = context("alice", "public-fixture", "task-b");
    for (const [ctx, task] of [[first, "payment"], [second, "booking"]] as const) {
      const scope = resolveUserMemoryScope(ctx)!;
      await memory.createThread(scope);
      await memory.updateWorkingMemory({ ...scope, workingMemory: task });
    }
    await service.change({ operation: "set", expectedRevision: 0, key: "language", value: "中文" }, first);
    expect((await service.read(second)).entries).toEqual([expect.objectContaining({ key: "language", value: "中文" })]);
    expect(await memory.getWorkingMemory(resolveUserMemoryScope(first)!)).toBe("payment");
    expect(await memory.getWorkingMemory(resolveUserMemoryScope(second)!)).toBe("booking");
    expect((await service.read(context("bob"))).entries).toEqual([]);
    expect((await service.read(context("alice", "another-fixture"))).entries).toEqual([]);
  });

  it("rejects stale concurrent updates across service instances and supports a safe retry", async () => {
    const { service, secondService } = fixture();
    const ctx = context();
    const results = await Promise.allSettled([
      service.change({ operation: "set", expectedRevision: 0, key: "language", value: "中文" }, ctx),
      secondService.change({ operation: "set", expectedRevision: 0, key: "format", value: "table" }, ctx),
    ]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    const latest = await secondService.read(ctx);
    await secondService.change({ operation: "set", expectedRevision: latest.revision, key: "format", value: "table" }, ctx);
    expect((await service.read(ctx)).entries.map(entry => entry.key)).toEqual(["language", "format"]);
  });

  it("forgets and clears preferences without deleting threads or resurrecting stale writes", async () => {
    const { service, memory } = fixture();
    const ctx = context();
    const scope = resolveUserMemoryScope(ctx)!;
    await memory.createThread(scope);
    await service.change({ operation: "set", expectedRevision: 0, key: "format", value: "table" }, ctx);
    await service.change({ operation: "forget", expectedRevision: 1, key: "format" }, ctx);
    expect(await service.read(ctx)).toMatchObject({ revision: 2, entries: [] });
    await expect(service.change({ operation: "set", expectedRevision: 1, key: "format", value: "table" }, ctx)).rejects.toThrow("another conversation");
    await service.change({ operation: "set", expectedRevision: 2, key: "language", value: "中文" }, ctx);
    expect(await service.change({ operation: "clear", expectedRevision: 3 }, ctx)).toMatchObject({ revision: 4, entries: [] });
    expect(await memory.getThreadById({ threadId: scope.threadId })).toBeTruthy();
  });

  it("fails closed for shared channels, absent identity and mismatched resources", async () => {
    const { service } = fixture();
    const anonymous = new RequestContext();
    const forged = context();
    forged.set(MASTRA_RESOURCE_ID_KEY, "qasey:public-fixture:bob");
    const invalid = [anonymous, forged];
    for (const channel of ["slack", "jira", "worker", { platform: "slack", userId: "alice" }]) {
      const shared = context();
      shared.set("channel", channel);
      invalid.push(shared);
    }
    for (const ctx of invalid) {
      expect(resolveUserMemoryScope(ctx)).toBeUndefined();
      await expect(service.read(ctx)).rejects.toThrow("authenticated private");
      await expect(service.change({ operation: "clear", expectedRevision: 0 }, ctx)).rejects.toThrow("authenticated private");
    }
  });

  it("refreshes processor context after updates without persisting or duplicating profile messages", async () => {
    const { service } = fixture();
    const ctx = context();
    const messageList = new MessageList();
    const processor = new UserMemoryProcessor(service);
    const args = { requestContext: ctx, messageList } as never;
    await processor.processInputStep(args);
    await service.change({ operation: "set", expectedRevision: 0, key: "format", value: "table" }, ctx);
    await processor.processInputStep(args);
    expect(messageList.getAllSystemMessages()).toHaveLength(1);
    expect(JSON.stringify(messageList.getAllSystemMessages())).toContain("table");
    expect(messageList.get.all.db()).toEqual([]);
    ctx.set("channel", "slack");
    await processor.processInputStep(args);
    expect(messageList.getAllSystemMessages()).toEqual([]);
  });

  it("exposes tools for Studio discovery and executes them with ordinary authenticated context", async () => {
    const { service } = fixture();
    vi.spyOn(runtime, "requireUserMemoryService").mockReturnValue(service);
    const agent = new Agent({ id: "user-memory-studio-fixture", name: "Memory fixture", model: "openai/gpt-5", instructions: "fixture", tools: { read_user_memory: readTool, update_user_memory: updateTool } });
    expect(Object.keys(await agent.listTools())).toEqual(["read_user_memory", "update_user_memory"]);
    const ctx = context();
    ctx.set("ingressSource", "mastra-studio");
    ctx.delete(MASTRA_THREAD_ID_KEY);
    ctx.set("MastraMemory", { thread: { id: "studio-generated-thread" } });
    for (const action of ["list", "read", "execute"]) {
      ctx.set("platform-resource-action", action);
      expect(Object.keys(await agent.listTools({ requestContext: ctx }))).toHaveLength(2);
    }
    const changed = await updateTool.execute!({ operation: "set", expectedRevision: 0, key: "format", value: "table" }, { requestContext: ctx } as never);
    expect(changed).toMatchObject({ revision: 1, entries: [expect.objectContaining({ sourceThreadId: "studio-generated-thread" })] });
    expect(await readTool.execute!({}, { requestContext: ctx } as never)).toEqual(changed);
  });

  it("rejects oversized updates and preserves unknown resource formats", async () => {
    const { service, memory } = fixture();
    const ctx = context();
    await expect(service.change({ operation: "set", expectedRevision: 0, key: "format", value: "x".repeat(501) }, ctx)).rejects.toThrow();
    await memory.updateWorkingMemory({ ...resolveUserMemoryScope(ctx)!, workingMemory: "legacy profile", memoryConfig: { workingMemory: { enabled: true, scope: "resource" } } });
    await expect(service.change({ operation: "clear", expectedRevision: 0 }, ctx)).rejects.toThrow();
    expect(await memory.getWorkingMemory({ ...resolveUserMemoryScope(ctx)!, memoryConfig: { workingMemory: { enabled: true, scope: "resource" } } })).toBe("legacy profile");
  });

  it("uses native recall to discover and read older threads, excluding other users and tenants", async () => {
    const { memory } = fixture();
    const current = resolveUserMemoryScope(context())!;
    const previous = resolveUserMemoryScope(context("alice", "public-fixture", "previous-task"))!;
    const foreign = resolveUserMemoryScope(context("bob"))!;
    const otherTenant = resolveUserMemoryScope(context("alice", "another-fixture"))!;
    for (const scope of [current, previous, foreign, otherTenant]) {
      await memory.createThread({ ...scope, title: scope === previous ? "Previous QA decision" : "Fixture" });
    }
    await memory.persistMessages([{ id: "previous-message", ...previous, role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "Use boundary coverage for the payment flow." }] } }]);
    const recall = memory.listTools().recall!;
    const execution = { memory, agent: current } as never;
    const listed = JSON.stringify(await recall.execute!({ mode: "threads" }, execution));
    expect(listed).toContain(previous.threadId);
    expect(listed).not.toContain(foreign.resourceId);
    expect(listed).not.toContain(otherTenant.resourceId);
    expect(JSON.stringify(await recall.execute!({ mode: "messages", threadId: previous.threadId }, execution))).toContain("boundary coverage");
    // Mastra tool execution can return a validation error rather than rejecting.
    for (const scope of [foreign, otherTenant]) {
      await expect(recall.execute!({ mode: "messages", threadId: scope.threadId }, execution)).rejects.toThrow(/resource|not found/iu);
    }
    expect(qaseyMemoryOptions.observationalMemory).toMatchObject({ scope: "thread", retrieval: { scope: "resource" }, observation: { manageWorkingMemory: true } });
  });
});
