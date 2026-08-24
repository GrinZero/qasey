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

  it("preserves numeric token usage while redacting credential-shaped tokens", () => {
    expect(sanitizeTelemetry({
      inputTokens: 123,
      outputTokens: 45,
      maxTokens: 1_000,
      accessToken: "secret",
      nested: { token: { value: "secret" } },
    })).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      maxTokens: 1_000,
      accessToken: "[redacted]",
      nested: { token: "[redacted]" },
    });
  });

  it("captures model input and output content only when explicitly enabled", () => {
    const span = {
      input: { messages: [{ role: "user", content: "visible prompt" }] },
      output: { content: "visible response" },
      metadata: { content: "unrelated private content" },
      authorization: "Bearer secret",
    };

    expect(sanitizeTelemetry(span)).toMatchObject({
      input: { messages: [{ content: "[redacted]" }] },
      output: { content: "[redacted]" },
      metadata: { content: "[redacted]" },
      authorization: "[redacted]",
    });
    expect(sanitizeTelemetry(span, { captureModelContent: true })).toMatchObject({
      input: { messages: [{ content: "visible prompt" }] },
      output: { content: "visible response" },
      metadata: { content: "[redacted]" },
      authorization: "[redacted]",
    });
  });
});
