import { createTool } from "@mastra/core/tools";
import type { ToolsInput } from "@mastra/core/agent";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { QaseyConfig } from "./config.ts";

const ReadConnectorOutputSchema = z.object({
  source: z.object({
    provider: z.enum(["slack", "jira"]),
    operation: z.string(),
    locator: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  data: z.unknown(),
});

type ReadConnectorOutput = z.infer<typeof ReadConnectorOutputSchema>;

const SlackLookupEmailSchema = z.string()
  .trim()
  .refine(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value), "Invalid email")
  .meta({ format: "email" });

/** Static upper bound used by safe experiment validation; credentials only reduce this set. */
export const QASEY_READ_CONNECTOR_TOOL_NAMES = [
  "slack_search_messages",
  "slack_get_thread",
  "slack_get_history",
  "slack_get_user",
  "slack_get_file",
  "jira_search_issues",
  "jira_get_issue",
] as const;

export class ReadConnectorCatalog {
  private readonly slackBot: WebClient | undefined;
  private readonly slackUser: WebClient | undefined;
  constructor(private readonly config: QaseyConfig) {
    this.slackBot = config.SLACK_BOT_TOKEN ? new WebClient(config.SLACK_BOT_TOKEN) : undefined;
    this.slackUser = config.SLACK_USER_TOKEN ? new WebClient(config.SLACK_USER_TOKEN) : undefined;
  }

  tools(): ToolsInput {
    return {
      ...(this.slackBot ? this.slackBotTools(this.slackBot) : {}),
      ...(this.slackUser ? this.slackSearchTool(this.slackUser) : {}),
      ...(this.config.JIRA_BASE_URL && this.config.JIRA_EMAIL && this.config.JIRA_API_TOKEN ? this.jiraTools() : {}),
    };
  }

  private slackSearchTool(client: WebClient): ToolsInput {
    return {
      slack_search_messages: createTool({
        id: "slack_search_messages", description: "使用 Slack 搜索语法搜索消息。只读。",
        inputSchema: z.object({ query: z.string().min(1), count: z.number().int().min(1).max(50).default(25) }),
        outputSchema: ReadConnectorOutputSchema,
        execute: async ({ query, count }) => readResult("slack", "search_messages", { query, count }, await client.search.messages({ query, count })),
        toModelOutput: boundedModelOutput,
      }),
    };
  }

  private slackBotTools(client: WebClient): ToolsInput {
    return {
      slack_get_thread: createTool({
        id: "slack_get_thread", description: "读取 Slack 线程中所有可见消息。只读。",
        inputSchema: z.object({ channel: z.string().min(1), threadTs: z.string().min(1), limit: z.number().int().min(1).max(100).default(100) }),
        outputSchema: ReadConnectorOutputSchema,
        execute: async ({ channel, threadTs, limit }) => readResult("slack", "get_thread", { channel, threadTs, limit }, await client.conversations.replies({ channel, ts: threadTs, limit })),
        toModelOutput: boundedModelOutput,
      }),
      slack_get_history: createTool({
        id: "slack_get_history", description: "读取 Slack 对话 ID 的最近消息。只读。",
        inputSchema: z.object({ channel: z.string().min(1), limit: z.number().int().min(1).max(100).default(50) }),
        outputSchema: ReadConnectorOutputSchema,
        execute: async ({ channel, limit }) => readResult("slack", "get_history", { channel, limit }, await client.conversations.history({ channel, limit })),
        toModelOutput: boundedModelOutput,
      }),
      slack_get_user: createTool({
        id: "slack_get_user", description: "通过用户 ID 或邮箱读取 Slack 用户资料。只读。",
        inputSchema: z.object({ userId: z.string().optional(), email: SlackLookupEmailSchema.optional() }).refine(value => value.userId || value.email, "userId or email is required"),
        outputSchema: ReadConnectorOutputSchema,
        execute: async ({ userId, email }) => readResult("slack", "get_user", userId ? { userId } : { email: email! }, userId ? await client.users.info({ user: userId }) : await client.users.lookupByEmail({ email: email! })),
        toModelOutput: boundedModelOutput,
      }),
      slack_get_file: createTool({
        id: "slack_get_file", description: "通过文件 ID 读取 Slack 文件元数据。只读，不暴露凭据。",
        inputSchema: z.object({ fileId: z.string().min(1) }),
        outputSchema: ReadConnectorOutputSchema,
        execute: async ({ fileId }) => readResult("slack", "get_file", { fileId }, await client.files.info({ file: fileId })),
        toModelOutput: boundedModelOutput,
      }),
    };
  }

  private jiraTools(): ToolsInput {
    return {
      jira_search_issues: createTool({
        id: "jira_search_issues", description: "使用 JQL 搜索 Jira issue。只读。",
        inputSchema: z.object({ jql: z.string().min(1), maxResults: z.number().int().min(1).max(50).default(20), fields: z.array(z.string()).default(["summary", "status", "description", "attachment"]) }),
        outputSchema: ReadConnectorOutputSchema,
        execute: async ({ jql, maxResults, fields }) => readResult("jira", "search_issues", { jql, maxResults }, await this.jiraFetch("/rest/api/3/search/jql", { jql, maxResults: String(maxResults), fields: fields.join(",") })),
        toModelOutput: boundedModelOutput,
      }),
      jira_get_issue: createTool({
        id: "jira_get_issue", description: "读取 Jira issue，包括附件元数据。只读。",
        inputSchema: z.object({ issueKey: z.string().min(1) }),
        outputSchema: ReadConnectorOutputSchema,
        execute: async ({ issueKey }) => readResult("jira", "get_issue", { issueKey }, await this.jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`)),
        toModelOutput: boundedModelOutput,
      }),
    };
  }

  private async jiraFetch(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, this.config.JIRA_BASE_URL);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.config.JIRA_EMAIL}:${this.config.JIRA_API_TOKEN}`).toString("base64")}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Jira read failed with ${response.status}`);
    return response.json();
  }
}

function readResult(
  provider: ReadConnectorOutput["source"]["provider"],
  operation: string,
  locator: ReadConnectorOutput["source"]["locator"],
  data: unknown,
): ReadConnectorOutput {
  return { source: { provider, operation, locator }, data };
}

function boundedModelOutput(output: ReadConnectorOutput): unknown {
  const maxChars = 32_000;
  let serialized: string;
  try {
    serialized = JSON.stringify(output.data) ?? String(output.data);
  } catch {
    serialized = String(output.data);
  }
  const truncated = serialized.length > maxChars;
  const source = JSON.stringify(output.source);
  const body = truncated ? serialized.slice(0, maxChars) : serialized;
  return {
    type: "text",
    value: `${source}\n${body}${truncated ? `\n[model output truncated from ${serialized.length} characters; narrow or paginate the source query for more detail]` : ""}`,
  };
}
