import { z } from "zod";
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

  it("keeps Slack email validation without emitting an unsupported regex pattern", () => {
    const catalog = new ReadConnectorCatalog(loadConfig({
      NODE_ENV: "test",
      SLACK_BOT_TOKEN: "xoxb-test",
    } as NodeJS.ProcessEnv));
    const schema = (catalog.tools().slack_get_user as { inputSchema: z.ZodType }).inputSchema;
    const jsonSchema = z.toJSONSchema(schema) as unknown as {
      properties: { email: { format?: string; pattern?: string } };
    };

    expect(jsonSchema.properties.email).toMatchObject({ format: "email" });
    expect(jsonSchema.properties.email).not.toHaveProperty("pattern");
    expect(schema.safeParse({ email: "qa@example.com" }).success).toBe(true);
    expect(schema.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });
});
