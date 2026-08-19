import { describe, expect, it } from "vitest";
import { sanitizeTelemetry } from "../../src/platform/observability/sanitize.ts";

describe("shared telemetry sanitizer", () => {
  it("redacts credentials, personal content, prompts, and oversized values", () => {
    expect(sanitizeTelemetry({
      applicationId: "qasey", tenantId: "tenant", requestId: "request",
      authorization: "Bearer secret", email: "person@example.test", prompt: "private text",
      nested: { token: "secret", safe: "x".repeat(2_100) },
    })).toMatchObject({
      applicationId: "qasey", tenantId: "tenant", requestId: "request",
      authorization: "[redacted]", email: "[redacted]", prompt: "[redacted]",
      nested: { token: "[redacted]", safe: expect.stringMatching(/…$/u) },
    });
  });
});
