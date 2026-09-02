import type {
  ReadConnectorCredentialResolver,
  ReadConnectorCredentials,
} from "../../../packages/adapters/src/read-connectors.ts";
import type { ExternalConnectionStore, RuntimeExternalConnection } from "./connection-store.ts";
import { publicHttpsEndpoint } from "../http/public-endpoint-policy.ts";

export class ConnectionBackedReadConnectorResolver implements ReadConnectorCredentialResolver {
  constructor(private readonly connections: ExternalConnectionStore) {}

  async resolve(tenantId: string): Promise<ReadConnectorCredentials> {
    const [slackConnections, jiraConnections] = await Promise.all([
      this.connections.findActive(tenantId, "slack"),
      this.connections.findActive(tenantId, "jira"),
    ]);
    const slackBotToken = credential(slackConnections, "botToken");
    const slackUserToken = credential(slackConnections, "userToken");
    const jira = jiraConnections.map(jiraCredentials).find((value): value is NonNullable<typeof value> => Boolean(value));
    return {
      ...(slackBotToken ? { slackBotToken } : {}),
      ...(slackUserToken ? { slackUserToken } : {}),
      ...(jira ? { jira } : {}),
    };
  }
}

function credential(connections: readonly RuntimeExternalConnection[], field: string): string | undefined {
  return connections.map(connection => connection.credentials[field]?.trim()).find(Boolean);
}

function jiraCredentials(connection: RuntimeExternalConnection): ReadConnectorCredentials["jira"] | undefined {
  const baseUrl = connection.configuration.baseUrl;
  const email = connection.credentials.email?.trim();
  const apiToken = connection.credentials.apiToken?.trim();
  if (typeof baseUrl !== "string" || !email || !apiToken) return undefined;
  try {
    return { baseUrl: publicHttpsEndpoint(baseUrl, "Tenant Jira endpoint").toString(), email, apiToken };
  } catch {
    return undefined;
  }
}
