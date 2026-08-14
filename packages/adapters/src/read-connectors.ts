import { createTool } from "@mastra/core/tools";
import type { ToolsInput } from "@mastra/core/agent";
import { Octokit } from "@octokit/rest";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { QaseyConfig } from "./config.ts";

export class ReadConnectorCatalog {
  private readonly slackBot: WebClient | undefined;
  private readonly slackUser: WebClient | undefined;
  private readonly github: Octokit | undefined;
  constructor(private readonly config: QaseyConfig) {
    this.slackBot = config.SLACK_BOT_TOKEN ? new WebClient(config.SLACK_BOT_TOKEN) : undefined;
    this.slackUser = config.SLACK_USER_TOKEN ? new WebClient(config.SLACK_USER_TOKEN) : undefined;
    this.github = config.GITHUB_TOKEN ? new Octokit({ auth: config.GITHUB_TOKEN }) : undefined;
  }

  tools(): ToolsInput {
    return {
      ...(this.slackBot ? this.slackBotTools(this.slackBot) : {}),
      ...(this.slackUser ? this.slackSearchTool(this.slackUser) : {}),
      ...(this.github ? this.githubTools(this.github) : {}),
      ...(this.config.JIRA_BASE_URL && this.config.JIRA_EMAIL && this.config.JIRA_API_TOKEN ? this.jiraTools() : {}),
    };
  }

  private slackSearchTool(client: WebClient): ToolsInput {
    return {
      slack_search_messages: createTool({
        id: "slack_search_messages", description: "Search Slack messages with Slack search syntax. Read-only.",
        inputSchema: z.object({ query: z.string().min(1), count: z.number().int().min(1).max(50).default(25) }),
        execute: async ({ query, count }) => compact(await client.search.messages({ query, count }), 80_000),
      }),
    };
  }

  private slackBotTools(client: WebClient): ToolsInput {
    return {
      slack_get_thread: createTool({
        id: "slack_get_thread", description: "Read all visible messages in a Slack thread. Read-only.",
        inputSchema: z.object({ channel: z.string().min(1), threadTs: z.string().min(1), limit: z.number().int().min(1).max(100).default(100) }),
        execute: async ({ channel, threadTs, limit }) => compact(await client.conversations.replies({ channel, ts: threadTs, limit }), 100_000),
      }),
      slack_get_history: createTool({
        id: "slack_get_history", description: "Read recent messages from a Slack conversation ID. Read-only.",
        inputSchema: z.object({ channel: z.string().min(1), limit: z.number().int().min(1).max(100).default(50) }),
        execute: async ({ channel, limit }) => compact(await client.conversations.history({ channel, limit }), 100_000),
      }),
      slack_get_user: createTool({
        id: "slack_get_user", description: "Read a Slack user profile by user ID or email. Read-only.",
        inputSchema: z.object({ userId: z.string().optional(), email: z.email().optional() }).refine(value => value.userId || value.email, "userId or email is required"),
        execute: async ({ userId, email }) => compact(userId ? await client.users.info({ user: userId }) : await client.users.lookupByEmail({ email: email! }), 20_000),
      }),
      slack_get_file: createTool({
        id: "slack_get_file", description: "Read Slack file metadata by file ID. Read-only; does not expose credentials.",
        inputSchema: z.object({ fileId: z.string().min(1) }),
        execute: async ({ fileId }) => compact(await client.files.info({ file: fileId }), 20_000),
      }),
    };
  }

  private githubTools(client: Octokit): ToolsInput {
    const repo = z.object({ owner: z.string().default(this.config.GITHUB_ORG), repo: z.string().min(1) });
    return {
      github_get_file: createTool({
        id: "github_get_file", description: "Read a file or directory listing from a GitHub repository. Read-only.",
        inputSchema: repo.extend({ path: z.string(), ref: z.string().default("main") }),
        execute: async ({ owner, repo, path, ref }) => compact((await client.repos.getContent({ owner, repo, path, ref })).data, 120_000),
      }),
      github_get_pull_request: createTool({
        id: "github_get_pull_request", description: "Read pull request metadata. Read-only.",
        inputSchema: repo.extend({ pullNumber: z.number().int().positive() }),
        execute: async ({ owner, repo, pullNumber }) => compact((await client.pulls.get({ owner, repo, pull_number: pullNumber })).data, 80_000),
      }),
      github_get_pull_request_diff: createTool({
        id: "github_get_pull_request_diff", description: "Read a pull request unified diff. Read-only.",
        inputSchema: repo.extend({ pullNumber: z.number().int().positive() }),
        execute: async ({ owner, repo, pullNumber }) => compact((await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: pullNumber, headers: { accept: "application/vnd.github.v3.diff" } })).data, 160_000),
      }),
      github_list_reviews: createTool({
        id: "github_list_reviews", description: "List reviews on a GitHub pull request. Read-only.",
        inputSchema: repo.extend({ pullNumber: z.number().int().positive() }),
        execute: async ({ owner, repo, pullNumber }) => compact((await client.pulls.listReviews({ owner, repo, pull_number: pullNumber })).data, 80_000),
      }),
      github_search_repositories: createTool({
        id: "github_search_repositories", description: `Search repositories, restricted to the ${this.config.GITHUB_ORG} organization. Read-only.`,
        inputSchema: z.object({ query: z.string().min(1), perPage: z.number().int().min(1).max(30).default(10) }),
        execute: async ({ query, perPage }) => compact((await client.search.repos({ q: `${query} org:${this.config.GITHUB_ORG}`, per_page: perPage })).data, 80_000),
      }),
    };
  }

  private jiraTools(): ToolsInput {
    return {
      jira_search_issues: createTool({
        id: "jira_search_issues", description: "Search Jira issues with JQL. Read-only.",
        inputSchema: z.object({ jql: z.string().min(1), maxResults: z.number().int().min(1).max(50).default(20), fields: z.array(z.string()).default(["summary", "status", "description", "attachment"]) }),
        execute: async ({ jql, maxResults, fields }) => this.jiraFetch("/rest/api/3/search/jql", { jql, maxResults: String(maxResults), fields: fields.join(",") }),
      }),
      jira_get_issue: createTool({
        id: "jira_get_issue", description: "Read a Jira issue, including attachment metadata. Read-only.",
        inputSchema: z.object({ issueKey: z.string().min(1) }),
        execute: async ({ issueKey }) => this.jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`),
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
    return compact(await response.json(), 120_000);
  }
}

function compact(value: unknown, maxLength: number): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxLength) return value;
  return { truncated: true, originalBytes: serialized.length, data: serialized.slice(0, maxLength) };
}
