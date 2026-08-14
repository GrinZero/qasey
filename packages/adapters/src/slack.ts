import { WebClient } from "@slack/web-api";

export class SlackLifecycleClient {
  private readonly client: WebClient | undefined;
  constructor(token?: string) {
    this.client = token ? new WebClient(token) : undefined;
  }

  get configured(): boolean { return Boolean(this.client); }

  async markProcessing(channel: string, timestamp: string): Promise<void> {
    await this.retry(() => this.requireClient().reactions.add({ channel, timestamp, name: "eyes" }));
  }

  async markSucceeded(channel: string, timestamp: string): Promise<void> {
    await this.removeEyes(channel, timestamp);
    await this.retry(() => this.requireClient().reactions.add({ channel, timestamp, name: "white_check_mark" }));
  }

  async markFailed(channel: string, timestamp: string, runId: string): Promise<void> {
    await this.removeEyes(channel, timestamp);
    await this.retry(() => this.requireClient().chat.postMessage({
      channel,
      thread_ts: timestamp,
      text: `:warning: 抱歉，这次操作没有成功。\nRun ID: \`${runId}\``,
      mrkdwn: true,
    }));
  }

  async postReply(channel: string, threadTs: string, text: string, idempotencyId?: string): Promise<void> {
    await this.retry(() => this.requireClient().chat.postMessage({
      channel, thread_ts: threadTs, text, mrkdwn: true,
      ...(idempotencyId ? { client_msg_id: idempotencyId } : {}),
    }));
  }

  async postProgress(channel: string, threadTs: string, text: string): Promise<string> {
    const result = await this.retry(() => this.requireClient().chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      mrkdwn: true,
    }));
    if (!result.ts) throw new Error("Slack did not return a timestamp for the progress message");
    return result.ts;
  }

  async updateProgress(channel: string, timestamp: string, text: string): Promise<void> {
    await this.retry(() => this.requireClient().chat.update({
      channel,
      ts: timestamp,
      text,
    }));
  }

  private async removeEyes(channel: string, timestamp: string): Promise<void> {
    try { await this.retry(() => this.requireClient().reactions.remove({ channel, timestamp, name: "eyes" })); } catch { /* best effort */ }
  }

  private requireClient(): WebClient {
    if (!this.client) throw new Error("SLACK_BOT_TOKEN is not configured");
    return this.client;
  }

  private async retry<T>(operation: () => Promise<T>, tries = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try { return await operation(); } catch (error) {
        lastError = error;
        if (attempt < tries) await new Promise(resolve => setTimeout(resolve, attempt * 300));
      }
    }
    throw lastError;
  }
}
