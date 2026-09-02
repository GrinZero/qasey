import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { AgentProgressSession } from "../../packages/domain/src/index.ts";
import { buildQaseyAgentTooling, createAgentProgressTool, getRuntimeContext, mcpCatalog, partitionQaseyCodeModeTools, studioMcpPreviewEnabled, toolsForRequest } from "../../src/mastra/runtime.ts";

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
    expect(runtime).not.toHaveProperty("intent-route");
    await expect(toolsForRequest()).rejects.toThrow("Qasey request context has not been initialized");
  });

  it("keeps MCP discovery disabled by default for authenticated Studio previews", async () => {
    const requestContext = new RequestContext();
    requestContext.set("identity", { userId: "studio-user", tenantId: "tenant-1", roles: ["user"], service: false });
    requestContext.set("requestId", "studio-request");
    requestContext.set("sessionId", "studio-session");
    requestContext.set("applicationId", "qasey");
    requestContext.set("ingressSource", "mastra-studio");
    const listModules = createTool({
      id: "figma_figma_list_pages",
      description: "List Figma pages",
      inputSchema: z.object({}),
      outputSchema: z.object({ modules: z.array(z.string()) }),
      execute: async () => ({ modules: [] }),
    });
    const discover = vi.spyOn(mcpCatalog, "toolsForDiscovery").mockResolvedValue({
      figma_figma_list_pages: listModules,
    });

    const tools = await toolsForRequest(requestContext);

    expect(studioMcpPreviewEnabled).toBe(false);
    expect(discover).not.toHaveBeenCalled();
    expect(tools).not.toHaveProperty("figma_figma_list_pages");
    discover.mockRestore();
  });

  it("rejects partial values injected under Qasey keys by a playground", () => {
    const requestContext = new RequestContext();
    requestContext.set("qasey-context", { mastra__isStudio: true });

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
    requestContext.set("qasey-context", context);

    expect(getRuntimeContext(requestContext, { allowStudioPreview: true })).toEqual({
      "qasey-context": context,
    });
  });

  it("keeps Code Mode dormant while retaining its read-only partition", async () => {
    const readTool = createTool({
      id: "github_get_file",
      description: "Read a repository file",
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => ({ path }),
    });
    const writeTool = createTool({
      id: "case_hub_create_change_set",
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
      caseHubCreateChangeSet: writeTool,
      qasey_report_progress: progressTool,
    });
    expect(Object.keys(partitioned.codeModeTools)).toEqual(["github_get_file"]);
    expect(Object.keys(partitioned.directTools)).toEqual([
      "caseHubCreateChangeSet",
      "qasey_report_progress",
    ]);

    const tooling = await buildQaseyAgentTooling({
      github_get_file: readTool,
      caseHubCreateChangeSet: writeTool,
      qasey_report_progress: progressTool,
    });
    expect(tooling.codeModeToolNames).toEqual([]);
    expect(Object.keys(tooling.tools)).toEqual([
      "github_get_file",
      "caseHubCreateChangeSet",
      "qasey_report_progress",
    ]);
    expect(tooling.codeModeInstructions).toBeUndefined();
  });

  it("rejects provider-incompatible schemas from the final request catalogue", async () => {
    const incompatible = createTool({
      id: "incompatible",
      description: "fixture",
      inputSchema: z.object({ value: z.string().regex(/^(?!bad).+$/u) }),
      execute: async ({ value }) => value,
    });

    await expect(buildQaseyAgentTooling({ incompatible })).rejects.toThrow(
      "OpenAI-incompatible tool schemas: incompatible$.properties.value.pattern",
    );
  });

  it("keeps the complete request-scoped tool catalogue OpenAI-compatible", async () => {
    const requestContext = new RequestContext();
    const context: QaseyRequestContext = {
      requestId: "request-schema-contract",
      channel: "api",
      sessionId: "session-schema-contract",
      chatInput: "validate the complete tool catalogue",
      actor: { id: "actor-schema-contract" },
      source: {},
      attachments: [],
    };
    requestContext.set("qasey-context", context);
    requestContext.set("agent-progress-session", new AgentProgressSession(() => undefined));
    const listCases = createTool({
      id: "figma_figma_list_pages",
      description: "List pages",
      inputSchema: z.object({}),
      execute: async () => ({ cases: [] }),
    });
    const discovery = vi.spyOn(mcpCatalog, "toolsForDiscovery").mockResolvedValue({
      figma_figma_list_pages: listCases,
    });

    const tools = await toolsForRequest(requestContext);
    const tooling = await buildQaseyAgentTooling(tools);

    expect(tooling.tools).toHaveProperty("getCurrentTime");
    expect(tooling.tools).toHaveProperty("qasey_report_progress");
    expect(tooling.tools).toHaveProperty("caseHubCreateChangeSet");
    expect(tooling.tools).toHaveProperty("figma_figma_list_pages");
    expect(tooling.codeModeToolNames).toEqual([]);
    discovery.mockRestore();
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
    }, { codeModeActive: true });
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

  it("keeps dormant Code Mode failure tracing covered for future reactivation", async () => {
    const observedSpans: Array<{ name: string; status: "success" | "error"; message?: string }> = [];
    const tools = {
      github_get_file: createTool({
        id: "github_get_file",
        description: "Read a repository file",
        inputSchema: z.object({ path: z.string() }),
        execute: async () => { throw new Error("upstream unavailable"); },
      }),
    };
    const tooling = await buildQaseyAgentTooling(tools, { codeModeActive: true });
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
        log: () => undefined,
      },
    })).resolves.toMatchObject({
      success: false,
      error: { message: "upstream unavailable" },
    });
    expect(observedSpans).toContainEqual({
      name: "code-mode external tool: 'github_get_file'",
      status: "error",
      message: "upstream unavailable",
    });
    expect(observedSpans).toContainEqual({ name: "code-mode:execute_typescript", status: "success" });
  });

  it("exposes qasey_report_progress as an agent-callable structured tool", async () => {
    const delivered: string[] = [];
    const tool = createAgentProgressTool(new AgentProgressSession(report => {
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
