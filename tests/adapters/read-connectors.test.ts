import { describe, expect, it } from "vitest";
import { boundedMcpModelOutput, loadConfig, ReadConnectorCatalog } from "../../packages/adapters/src/index.ts";

describe("native tool model output shaping", () => {
  it("does not expose GitHub file and diff reads as model tools", () => {
    const catalog = new ReadConnectorCatalog(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv));
    expect(Object.keys(catalog.tools()).filter(name => name.startsWith("github_"))).toEqual([]);
  });

  it("bounds MCP results when the upstream tool has no toModelOutput mapper", () => {
    const output = boundedMcpModelOutput({ content: "x".repeat(50_000) }) as { type: string; value: string };
    expect(output.type).toBe("text");
    expect(output.value.length).toBeLessThan(34_000);
    expect(output.value).toContain("model output truncated");
  });
});
