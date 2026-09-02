import { describe, expect, it } from "vitest";
import { assertPublicHostname, publicHttpsEndpoint } from "../../src/platform/http/public-endpoint-policy.ts";

describe("tenant-managed public endpoint policy", () => {
  it("accepts public HTTPS DNS endpoints and explicit public ports", () => {
    expect(publicHttpsEndpoint("https://mcp.example.com/api").hostname).toBe("mcp.example.com");
    expect(publicHttpsEndpoint("https://jira.example.com:8443/").port).toBe("8443");
    expect(() => assertPublicHostname("xn--bcher-kva.example")).not.toThrow();
  });

  it.each([
    "http://mcp.example.com",
    "https://user:password@mcp.example.com",
    "https://mcp.example.com/#fragment",
    "https://localhost",
    "https://metadata.home.arpa",
    "https://service.local",
    "https://10.0.0.1",
    "https://127.0.0.1",
    "https://[::1]",
    "https://single-label",
  ])("rejects non-public or secret-bearing endpoint %s", endpoint => {
    expect(() => publicHttpsEndpoint(endpoint)).toThrow(/public|HTTPS|credentials|fragment/iu);
  });
});
