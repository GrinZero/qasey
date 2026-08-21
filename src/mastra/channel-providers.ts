import type { ChannelProvider } from "@mastra/core/channels";
import { InMemoryChannelsStorage } from "@mastra/core/storage";
import { SlackProvider } from "@mastra/slack";
import type { QaseyConfig } from "../../packages/adapters/src/config.ts";

type SlackProviderEnvironment = Pick<
  QaseyConfig,
  | "DATABASE_URL"
  | "MASTRA_ENCRYPTION_KEY"
  | "QASEY_PUBLIC_BASE_URL"
  | "SLACK_APP_CONFIG_REFRESH_TOKEN"
  | "SLACK_APP_CONFIG_TOKEN"
  | "SLACK_BASE_URL"
>;

/**
 * Runtime-level channel providers are intentionally separate from the
 * agent-level adapters in applications/qasey/channels.ts. Registering this
 * provider exposes provisioning and OAuth without taking over the existing
 * Slack app; an adapter is only installed after an explicit connect flow.
 */
export function createQaseyChannelProviders(config: SlackProviderEnvironment) {
  return {
    slack: new SlackProvider({
      baseUrl: config.SLACK_BASE_URL ?? config.QASEY_PUBLIC_BASE_URL,
      // Local Qasey intentionally has no primary Mastra store. Keep provider
      // registration non-breaking there; deployed runtimes use Postgres.
      ...(config.DATABASE_URL ? {} : { storage: new InMemoryChannelsStorage() }),
      ...(config.SLACK_APP_CONFIG_REFRESH_TOKEN
        ? {
            refreshToken: config.SLACK_APP_CONFIG_REFRESH_TOKEN,
            ...(config.SLACK_APP_CONFIG_TOKEN ? { token: config.SLACK_APP_CONFIG_TOKEN } : {}),
          }
        : {}),
      ...(config.MASTRA_ENCRYPTION_KEY ? { encryptionKey: config.MASTRA_ENCRYPTION_KEY } : {}),
    }),
  } satisfies Record<string, ChannelProvider>;
}
