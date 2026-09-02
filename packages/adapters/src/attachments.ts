import type { AttachmentRef } from "../../contracts/src/index.ts";
import type { QaseyConfig } from "./config.ts";

export interface ModelFilePart { type: "file"; data: Uint8Array; mimeType: string; filename: string; }

export async function loadModelAttachments(attachments: AttachmentRef[], config: QaseyConfig): Promise<ModelFilePart[]> {
  const supported = attachments.filter(item => item.url && (/^image\//.test(item.mimeType) || item.mimeType === "application/pdf")).slice(0, 5);
  return Promise.all(supported.map(async attachment => {
    const url = new URL(attachment.url!);
    const headers: Record<string, string> = {};
    if (attachment.source === "slack") {
      if (!config.SLACK_BOT_TOKEN || !isSlackFileHost(url.hostname)) throw new Error("Slack attachment host or credentials are invalid");
      headers.Authorization = `Bearer ${config.SLACK_BOT_TOKEN}`;
    } else if (attachment.source === "jira") {
      if (!config.JIRA_BASE_URL || url.origin !== new URL(config.JIRA_BASE_URL).origin || !config.JIRA_EMAIL || !config.JIRA_API_TOKEN) throw new Error("Jira attachment host or credentials are invalid");
      headers.Authorization = `Basic ${Buffer.from(`${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`).toString("base64")}`;
    } else {
      throw new Error("API attachment downloads require a managed artifact reference");
    }
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Attachment download failed with ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > 20_000_000) throw new Error(`Attachment is too large: ${attachment.name}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > 20_000_000) throw new Error(`Attachment is too large: ${attachment.name}`);
    return { type: "file", data, mimeType: attachment.mimeType, filename: attachment.name };
  }));
}

function isSlackFileHost(hostname: string): boolean {
  return hostname === "slack.com" || hostname.endsWith(".slack.com") || hostname === "files.slack.com";
}
