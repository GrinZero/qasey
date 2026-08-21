import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { boundedMcpModelOutput, loadConfig, ReadConnectorCatalog } from "../../packages/adapters/src/index.ts";

describe("native tool model output shaping", () => {
  it("keeps the full GitHub result for the app and bounds only what the model receives", async () => {
    const content = "x".repeat(50_000);
    const github = {
      repos: { getContent: vi.fn(async () => ({ data: { content } })) },
    } as unknown as Octokit;
    const catalog = new ReadConnectorCatalog(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), github);
    const tool = catalog.tools().github_get_file as {
      execute: (input: unknown, context: unknown) => Promise<any>;
      toModelOutput: (output: any) => { type: string; value: string };
      outputSchema?: unknown;
    };

    const raw = await tool.execute({ owner: "moego", repo: "qasey", path: "README.md", ref: "main" }, {});
    const modelOutput = tool.toModelOutput(raw);

    expect(raw.data.content).toHaveLength(50_000);
    expect(raw.source).toMatchObject({ provider: "github", operation: "get_file" });
    expect(tool.outputSchema).toBeDefined();
    expect(modelOutput.type).toBe("text");
    expect(modelOutput.value.length).toBeLessThan(34_000);
    expect(modelOutput.value).toContain("model output truncated");
  });

  it("bounds MCP results when the upstream tool has no toModelOutput mapper", () => {
    const output = boundedMcpModelOutput({ content: "x".repeat(50_000) }) as { type: string; value: string };
    expect(output.type).toBe("text");
    expect(output.value.length).toBeLessThan(34_000);
    expect(output.value).toContain("model output truncated");
  });
});
