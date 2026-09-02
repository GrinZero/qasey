import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  assertOpenAICompatibleToolSchemas,
  findUnsupportedOpenAIRegexPatterns,
  loadConfig,
  ReadConnectorCatalog,
  sanitizeOpenAIToolInputSchema,
} from "../../packages/adapters/src/index.ts";

describe("OpenAI tool schema compatibility", () => {
  it("sanitizes unsupported MCP regex features without weakening supported patterns", () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string", format: "email", pattern: "^(?!\\.)[^@]+@[^@]+$" },
        slug: { type: "string", pattern: "^[a-z0-9_-]+$" },
      },
    };

    expect(sanitizeOpenAIToolInputSchema(schema)).toEqual({
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        slug: { type: "string", pattern: "^[a-z0-9_-]+$" },
      },
    });
    expect(schema.properties.email).toHaveProperty("pattern");
  });

  it("detects lookarounds and backreferences anywhere in a schema", () => {
    const issues = findUnsupportedOpenAIRegexPatterns({
      anyOf: [
        { type: "string", pattern: "(?<=prefix)value" },
        { type: "string", pattern: "^(value)-\\1$" },
      ],
    });

    expect(issues.map(issue => issue.path)).toEqual([
      "$.anyOf[0].pattern",
      "$.anyOf[1].pattern",
    ]);
  });

  it("rejects an incompatible final catalogue before a model request", () => {
    const incompatible = createTool({
      id: "bad_tool",
      description: "fixture",
      inputSchema: z.object({ value: z.string().regex(/^(?!bad).+$/u) }),
      execute: async ({ value }) => value,
    });

    expect(() => assertOpenAICompatibleToolSchemas({ bad_tool: incompatible })).toThrow(
      "OpenAI-incompatible tool schemas: bad_tool$.properties.value.pattern",
    );
  });

  it("accepts the complete native Slack and Jira connector catalogue", () => {
    const tools = new ReadConnectorCatalog(loadConfig({
      NODE_ENV: "test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_USER_TOKEN: "xoxp-test",
      JIRA_BASE_URL: "https://jira.example.test",
      JIRA_EMAIL: "qa@example.test",
      JIRA_API_TOKEN: "test-token",
    } as NodeJS.ProcessEnv)).tools();

    expect(Object.keys(tools).sort()).toEqual([
      "jira_get_issue",
      "jira_search_issues",
      "slack_get_file",
      "slack_get_history",
      "slack_get_thread",
      "slack_get_user",
      "slack_search_messages",
    ]);
    expect(() => assertOpenAICompatibleToolSchemas(tools)).not.toThrow();
  });
});
