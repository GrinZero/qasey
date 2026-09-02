import { isIP } from "node:net";

const RESERVED_DNS_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".invalid",
] as const;

/**
 * Application-layer SSRF guard for tenant-managed provider endpoints.
 * Production deployments must additionally enforce an egress network policy:
 * DNS can change after validation and only the network boundary can make that
 * race non-bypassable.
 */
export function publicHttpsEndpoint(value: string, label = "External endpoint"): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (endpoint.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error(`${label} cannot contain URL credentials or a fragment`);
  }
  assertPublicHostname(endpoint.hostname, label);
  return endpoint;
}

export function assertPublicHostname(value: string, label = "External endpoint"): void {
  const hostname = value.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (!hostname || isIP(hostname) !== 0) {
    throw new Error(`${label} must use a public DNS hostname, not an IP literal`);
  }
  if (!hostname.includes(".") || hostname === "localhost"
    || RESERVED_DNS_SUFFIXES.some(suffix => hostname.endsWith(suffix))) {
    throw new Error(`${label} must use a public DNS hostname`);
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(hostname)
    || hostname.split(".").some(labelPart => !labelPart || labelPart.length > 63 || labelPart.startsWith("-") || labelPart.endsWith("-"))) {
    throw new Error(`${label} contains an invalid DNS hostname`);
  }
}
