import type { MastraFetchLike } from "@mastra/mcp";

export interface ForwardedCredential {
  authorization?: string;
  cookie?: string;
}

export function createCredentialForwardingFetch(options: {
  allowedHosts: readonly string[];
  credentialKey?: string;
}): MastraFetchLike {
  const allowedHosts = new Set(options.allowedHosts);
  const credentialKey = options.credentialKey ?? "mcp-forwarded-credential";
  return async (input, init, requestContext) => {
    const url = new URL(input);
    if (!allowedHosts.has(url.host)) throw new Error(`MCP request host is not allowed: ${url.host}`);
    const credential = requestContext?.get(credentialKey) as ForwardedCredential | undefined;
    if (!credential) throw new Error("Request-scoped MCP credential is missing");
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    if (credential.authorization) headers.set("authorization", credential.authorization);
    if (credential.cookie) headers.set("cookie", credential.cookie);
    return fetch(url, { ...init, headers });
  };
}

