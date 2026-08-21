import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { AgentProgressSession, EvidenceLedger } from "../../packages/domain/src/index.ts";
import { buildQaseyAgentTooling, createAgentProgressTool, getRuntimeContext, guardCaseMutationsForWorkflow, guardToolsWithEvidence, mcpCatalog, partitionQaseyCodeModeTools, studioMcpPreviewEnabled, toolsForRequest } from "../../src/mastra/runtime.ts";

describe("Qasey runtime context", () => {
  it("keeps missing context strict for production callers", () => {
    expect(() => getRuntimeContext()).toThrow("Qasey request context has not been initialized");
  });

  it("provides a read-only fallback for Mastra Studio", async () => {
    const runtime = getRuntimeContext(undefined, { allowStudioPreview: true });

    expect(runtime["qasey-context"]).toMatchObject({
      channel: "api",
      sessionId: "mastra-studio",
    });
    expect(runtime["intent-route"]).toMatchObject({
      intent: "unknown",
      writeTarget: "none",
      routerStatus: "fallback",
    });
    await expect(toolsForRequest()).rejects.toThrow("Qasey request context has not been initialized");
  });

  it("keeps Studio MCP discovery opt-in even when authenticated context is native", async () => {
    const requestContext = new RequestContext();
    requestContext.set("identity", { userId: "studio-user", tenantId: "tenant-1", roles: ["user"], service: false });
    requestContext.set("requestId", "studio-request");
    requestContext.set("sessionId", "studio-session");
    requestContext.set("ingressSource", "mastra-studio");
    const discover = vi.spyOn(mcpCatalog, "toolsFor");

    const tools = await toolsForRequest(requestContext);

    expect(studioMcpPreviewEnabled).toBe(false);
    expect(discover).not.toHaveBeenCalled();
    expect(tools).toHaveProperty("getCurrentTime");
    discover.mockRestore();
  });

  it("rejects partial values injected under Qasey keys by a playground", () => {
    const requestContext = new RequestContext();
    requestContext.set("qasey-context", { mastra__isStudio: true });
    requestContext.set("intent-route", {});

    expect(getRuntimeContext(requestContext, { allowStudioPreview: true })).toEqual(
      getRuntimeContext(undefined, { allowStudioPreview: true }),
    );
    expect(() => getRuntimeContext(requestContext)).toThrow(
      "Qasey request context has not been initialized",
    );
  });

  it("preserves explicitly initialized request context", () => {
    const requestContext = new RequestContext();
    const context: QaseyRequestContext = {
      requestId: "request-1",
      channel: "api",
      sessionId: "session-1",
      chatInput: "review this requirement",
      actor: { id: "actor-1" },
      source: {},
      attachments: [],
    };
    const route: IntentRoute = {
      version: 2,
      intent: "qa_review",
      relation: "new",
      writeTarget: "none",
      depth: "deep",
      confidence: 1,
      reason: "test",
      routerStatus: "ok",
    };
    requestContext.set("qasey-context", context);
    requestContext.set("intent-route", route);

    expect(getRuntimeContext(requestContext, { allowStudioPreview: true })).toEqual({
      "qasey-context": context,
      "intent-route": route,
    });
  });

  it("guards dynamically resolved tools with the request evidence ledger", async () => {
    const execute = vi.fn(async ({ value }: { value: string }) => ({ value }));
    const guarded = guardToolsWithEvidence({
      lookup: createTool({
        id: "lookup",
        description: "test",
        inputSchema: z.object({ value: z.string() }),
        execute,
      }),
    }, new EvidenceLedger("run-guard"));
    const guardedExecute = (guarded.lookup as { execute: (input: unknown, context: unknown) => Promise<unknown> }).execute;

    await expect(guardedExecute({ value: "one" }, {})).resolves.toEqual({ value: "one" });
    await expect(guardedExecute({ value: "one" }, {})).resolves.toMatchObject({ status: "already_acquired" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("places only read tools behind Code Mode and keeps side effects direct", async () => {
    const readTool = createTool({
      id: "github_get_file",
      description: "Read a repository file",
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => ({ path }),
    });
    const writeTool = createTool({
      id: "metersphere_ms_bulk_upsert_test_cases",
      description: "Write test cases",
      inputSchema: z.object({ items: z.array(z.string()) }),
      execute: async ({ items }) => ({ count: items.length }),
    });
    const progressTool = createTool({
      id: "qasey_report_progress",
      description: "Report progress",
      inputSchema: z.object({ title: z.string() }),
      execute: async () => ({ accepted: true }),
    });

    const partitioned = partitionQaseyCodeModeTools({
      github_get_file: readTool,
      metersphere_ms_bulk_upsert_test_cases: writeTool,
      qasey_report_progress: progressTool,
    });
    expect(Object.keys(partitioned.codeModeTools)).toEqual(["github_get_file"]);
    expect(Object.keys(partitioned.directTools)).toEqual([
      "metersphere_ms_bulk_upsert_test_cases",
      "qasey_report_progress",
    ]);

    const tooling = await buildQaseyAgentTooling({
      github_get_file: readTool,
      metersphere_ms_bulk_upsert_test_cases: writeTool,
      qasey_report_progress: progressTool,
    });
    expect(tooling.codeModeToolNames).toEqual(["github_get_file"]);
    expect(Object.keys(tooling.tools)).toEqual([
      "metersphere_ms_bulk_upsert_test_cases",
      "qasey_report_progress",
      "execute_typescript",
    ]);
    expect(tooling.codeModeInstructions).toContain("external_github_get_file");
    expect(tooling.codeModeInstructions).not.toContain("external_metersphere_ms_bulk_upsert_test_cases");
    expect(tooling.codeModeInstructions).not.toContain("external_qasey_report_progress");
  });

  it("runs parallel read tools through the isolated QuickJS Code Mode transport", async () => {
    const seen: string[] = [];
    const observedSpans: Array<{ name: string; status: "success" | "error" }> = [];
    const requestContext = new RequestContext();
    const tooling = await buildQaseyAgentTooling({
      github_get_file: createTool({
        id: "github_get_file",
        description: "Read a repository file",
        inputSchema: z.object({ path: z.string() }),
        outputSchema: z.object({ path: z.string(), contextForwarded: z.boolean() }),
        execute: async ({ path }, context) => {
          seen.push(path);
          return { path, contextForwarded: context.requestContext === requestContext };
        },
      }),
    });
    const execute = (tooling.tools.execute_typescript as {
      execute: (input: unknown, context: unknown) => Promise<unknown>;
    }).execute;

    await expect(execute({
      code: `const paths = ["a.ts", "b.ts"];
const files = await Promise.all(paths.map(path => external_github_get_file({ path })));
return files;`,
    }, {
      requestContext,
      observe: {
        span: async (name: string, operation: () => Promise<unknown>) => {
          try {
            const result = await operation();
            observedSpans.push({ name, status: "success" });
            return result;
          } catch (error) {
            observedSpans.push({ name, status: "error" });
            throw error;
          }
        },
        log: () => undefined,
      },
    })).resolves.toEqual({
      success: true,
      result: [
        { path: "a.ts", contextForwarded: true },
        { path: "b.ts", contextForwarded: true },
      ],
      logs: [],
    });
    expect(seen.sort()).toEqual(["a.ts", "b.ts"]);
    expect(observedSpans).toEqual(expect.arrayContaining([
      { name: "code-mode external tool: 'github_get_file'", status: "success" },
      { name: "code-mode external tool: 'github_get_file'", status: "success" },
      { name: "code-mode:execute_typescript", status: "success" },
    ]));
  });

  it("marks a Code Mode failure receipt on its child span without changing agent control flow", async () => {
    const observedSpans: Array<{ name: string; status: "success" | "error"; message?: string }> = [];
    const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
    const guarded = guardToolsWithEvidence({
      github_get_file: createTool({
        id: "github_get_file",
        description: "Read a repository file",
        inputSchema: z.object({ path: z.string() }),
        execute: async () => { throw new Error("upstream unavailable"); },
      }),
    }, new EvidenceLedger("run-code-mode-failure"));
    const tooling = await buildQaseyAgentTooling(guarded);
    const execute = (tooling.tools.execute_typescript as {
      execute: (input: unknown, context: unknown) => Promise<unknown>;
    }).execute;

    await expect(execute({
      code: `return external_github_get_file({ path: "missing.ts" });`,
    }, {
      requestContext: new RequestContext(),
      observe: {
        span: async (name: string, operation: () => Promise<unknown>) => {
          try {
            const result = await operation();
            observedSpans.push({ name, status: "success" });
            return result;
          } catch (error) {
            observedSpans.push({
              name,
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
        log: (level: string, message: string, data?: Record<string, unknown>) => {
          logs.push({ level, message, ...(data ? { data } : {}) });
        },
      },
    })).resolves.toMatchObject({
      success: true,
      result: {
        status: "failed",
        errorCode: "TOOL_EXECUTION_ERROR",
        message: "upstream unavailable",
      },
    });
    expect(observedSpans).toContainEqual({
      name: "code-mode external tool: 'github_get_file'",
      status: "error",
      message: "upstream unavailable",
    });
    expect(observedSpans).toContainEqual({ name: "code-mode:execute_typescript", status: "success" });
    expect(logs).toContainEqual(expect.objectContaining({
      level: "error",
      message: "code-mode external tool returned a structured failure",
      data: expect.objectContaining({ toolId: "github_get_file", error: "upstream unavailable" }),
    }));
  });

  it("lets the agent dry-run a CasePlan but reserves real case mutations for the workflow", async () => {
    const bulkExecute = vi.fn(async () => ({ ok: true }));
    const createExecute = vi.fn(async () => ({ ok: true }));
    const guarded = guardCaseMutationsForWorkflow({
      metersphere_ms_bulk_upsert_test_cases: createTool({
        id: "metersphere_ms_bulk_upsert_test_cases",
        description: "test bulk upsert",
        inputSchema: z.object({ items: z.string(), dry_run: z.boolean() }),
        execute: bulkExecute,
      }),
      metersphere_ms_create_test_case: createTool({
        id: "metersphere_ms_create_test_case",
        description: "test single create",
        inputSchema: z.object({ name: z.string() }),
        execute: createExecute,
      }),
    });
    const bulk = (guarded.metersphere_ms_bulk_upsert_test_cases as { execute: (input: unknown, context: unknown) => Promise<unknown> }).execute;
    const create = (guarded.metersphere_ms_create_test_case as { execute: (input: unknown, context: unknown) => Promise<unknown> }).execute;

    await expect(bulk({ items: "[]", dry_run: true }, {})).resolves.toEqual({ ok: true });
    await expect(bulk({ items: "[]", dry_run: false }, {})).rejects.toThrow(/owned by the MeterSphere case operation workflow/i);
    await expect(create({ name: "case" }, {})).rejects.toThrow(/owned by the MeterSphere case operation workflow/i);
    expect(bulkExecute).toHaveBeenCalledTimes(1);
    expect(createExecute).not.toHaveBeenCalled();
  });

  it("exposes qasey_report_progress as an agent-callable structured tool", async () => {
    const delivered: string[] = [];
    const route: IntentRoute = {
      version: 2,
      intent: "qa_review",
      relation: "new",
      writeTarget: "none",
      depth: "standard",
      confidence: 1,
      reason: "test",
      routerStatus: "ok",
    };
    const tool = createAgentProgressTool(new AgentProgressSession(route, report => {
      delivered.push(report.milestone);
    }));
    const execute = (tool as { execute: (input: unknown, context: unknown) => Promise<unknown> }).execute;

    await expect(execute({
      milestone: "evidence",
      title: "正在核对退款规则",
      detail: "Jira 和代码对超时退款的描述不一致。",
      next: "确认线上实际行为",
    }, {})).resolves.toMatchObject({ accepted: true, milestone: "evidence", sequence: 1 });
    expect(delivered).toEqual(["evidence"]);
  });
});
