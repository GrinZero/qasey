import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyWebhookToken } from "../../packages/adapters/src/jira.ts";

describe("verifyWebhookToken", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never authenticates a request that did not present a token", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(verifyWebhookToken(undefined, undefined)).toBe(false);
    expect(verifyWebhookToken(undefined, "configured-token")).toBe(false);
  });

  it("keeps the explicit development-only unconfigured-token convenience", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(verifyWebhookToken("presented-token", undefined)).toBe(true);
  });

  it("requires an exact configured token in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(verifyWebhookToken("presented-token", undefined)).toBe(false);
    expect(verifyWebhookToken("wrong-token", "configured-token")).toBe(false);
    expect(verifyWebhookToken("configured-token", "configured-token")).toBe(true);
  });
});
