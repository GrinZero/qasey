import { timingSafeEqual } from "node:crypto";

export class JiraClient {
  constructor(
    private readonly baseUrl?: string,
    private readonly email?: string,
    private readonly token?: string,
  ) {}

  get configured(): boolean { return Boolean(this.baseUrl && this.email && this.token); }

  async addComment(issueKey: string, text: string): Promise<void> {
    if (!this.configured) throw new Error("Jira credentials are not configured");
    const response = await fetch(`${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.email}:${this.token}`).toString("base64")}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: adfDocument(`🤖 Qasey\n\n${text}`) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Jira comment failed with ${response.status}`);
  }
}

function adfDocument(text: string) {
  return {
    type: "doc", version: 1,
    content: text.split("\n").map(line => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })),
  };
}

export function verifyWebhookToken(actual: string | undefined, expected: string | undefined): boolean {
  if (!expected) return process.env.NODE_ENV !== "production";
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
