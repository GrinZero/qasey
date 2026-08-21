import { SlackProvider } from "@mastra/slack";
import { Mastra } from "@mastra/core/mastra";
import { describe, expect, it } from "vitest";
import { createQaseyChannelProviders } from "../../src/mastra/channel-providers.ts";

describe("Qasey runtime channel providers", () => {
  it("registers and initializes SlackProvider locally without provider credentials", async () => {
    const providers = createQaseyChannelProviders({
      QASEY_PUBLIC_BASE_URL: "http://localhost:4111",
    });
    new Mastra({ channels: providers });

    expect(providers.slack).toBeInstanceOf(SlackProvider);
    expect(providers.slack.getInfo()).toMatchObject({ id: "slack", isConfigured: false });
    await expect(providers.slack.initialize()).resolves.toBeUndefined();
    expect(providers.slack.getRoutes().map(route => `${route.method} ${route.path}`)).toContain(
      "POST /slack/events/:webhookId",
    );
  });

  it("seeds SlackProvider App Manifest credentials when explicitly configured", () => {
    const providers = createQaseyChannelProviders({
      QASEY_PUBLIC_BASE_URL: "https://qasey.example.com",
      SLACK_APP_CONFIG_TOKEN: "xoxe-config-token",
      SLACK_APP_CONFIG_REFRESH_TOKEN: "xoxe-refresh-token",
      MASTRA_ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough",
    });

    expect(providers.slack.isConfigured()).toBe(true);
  });
});
