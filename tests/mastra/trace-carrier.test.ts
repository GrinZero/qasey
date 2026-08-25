import { describe, expect, it } from "vitest";
import {
  DatadogTraceCarrierSchema,
  fallbackTraceCarrier,
  normalizeDatadogTraceCarrier,
  QaseyRemoteTraceContextSchema,
} from "../../src/mastra/applications/qasey/trace-carrier.ts";

describe("Qasey distributed trace carrier", () => {
  it("builds a valid W3C fallback from Mastra identifiers", () => {
    expect(fallbackTraceCarrier("abc123", "def456")).toEqual({
      traceparent: "00-00000000000000000000000000abc123-0000000000def456-01",
    });
  });

  it("normalizes supported Datadog headers and rejects arbitrary tunnel headers", () => {
    expect(normalizeDatadogTraceCarrier({
      TraceParent: "00-6a8d122f000000006d4819df8dbc2a31-2178a1ab9a296f75-01",
      "X-Datadog-Trace-Id": 42,
    })).toEqual({
      traceparent: "00-6a8d122f000000006d4819df8dbc2a31-2178a1ab9a296f75-01",
      "x-datadog-trace-id": "42",
    });
    expect(normalizeDatadogTraceCarrier({ authorization: "secret" })).toBeUndefined();
  });

  it("keeps the tunnel context strict and size bounded", () => {
    expect(QaseyRemoteTraceContextSchema.parse({
      traceId: "6a8d122f000000006d4819df8dbc2a31",
      parentSpanId: "2178a1ab9a296f75",
      carrier: DatadogTraceCarrierSchema.parse({
        "x-datadog-tags": "_dd.p.llmobs_parent_id=2178a1ab9a296f75",
      }),
    })).toBeTruthy();
    expect(() => QaseyRemoteTraceContextSchema.parse({
      traceId: "not-hex",
      parentSpanId: "2178a1ab9a296f75",
    })).toThrow();
  });
});
