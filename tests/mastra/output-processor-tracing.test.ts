import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { SpanType } from "@mastra/core/observability";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Observability, TestExporter } from "@mastra/observability";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const EmptySchema = z.object({});
const ResultSchema = z.object({ text: z.string() });

describe("Mastra output processor tracing patch", () => {
  it("keeps a durable output stream processor under the supplied outer workflow trace", async () => {
    const exporter = new TestExporter({
      storeLogs: false,
      logMetricsOnFlush: false,
    });
    const observability = new Observability({
      configs: {
        default: {
          serviceName: "output-processor-tracing-test",
          exporters: [exporter],
        },
      },
    });

    const agent = new Agent({
      id: "trace-probe",
      name: "Trace probe",
      instructions: "Reply briefly.",
      model: createMockModel({ mockText: "hello", version: "v2" }),
      // Keep the regression faithful to Qasey without leaving the default
      // durable cleanup timer alive after the test completes.
      durable: { cleanupTimeoutMs: 10 },
      outputProcessors: [{
        id: "chat-channel-render",
        processOutputStream: async ({ part }) => part,
      }],
    });

    const callAgentStep = createStep({
      id: "call-agent",
      inputSchema: EmptySchema,
      outputSchema: ResultSchema,
      execute: async ({ mastra, tracingContext }) => {
        const stream = await mastra.getAgent("traceProbe").stream("hello", {
          ...(tracingContext ? { tracingContext } : {}),
        }) as unknown as {
          output: { text: Promise<string> };
          cleanup: () => void;
        };
        try {
          return { text: await stream.output.text };
        } finally {
          stream.cleanup();
        }
      },
    });

    const outerWorkflow = createWorkflow({
      id: "outer-trace-probe",
      inputSchema: EmptySchema,
      outputSchema: ResultSchema,
    })
      .then(callAgentStep)
      .commit();

    const mastra = new Mastra({
      agents: { traceProbe: agent },
      workflows: { outerTraceProbe: outerWorkflow },
      observability,
    });

    const tracing = mastra.observability.getDefaultInstance();
    expect(tracing).toBeDefined();

    const externalParent = tracing!.startSpan({
      type: SpanType.GENERIC,
      name: "external parent",
    });
    let externalParentEnded = false;

    try {
      const run = await mastra.getWorkflow("outerTraceProbe").createRun();
      const result = await run.start({
        inputData: {},
        tracingContext: { currentSpan: externalParent },
      });

      expect(result).toMatchObject({
        status: "success",
        result: { text: "hello" },
      });

      externalParent.end();
      externalParentEnded = true;

      // Export delivery is asynchronous, so wait for the relationship itself
      // instead of relying on a fixed delay.
      await vi.waitFor(() => {
        const processorSpan = exporter
          .getSpansByType(SpanType.PROCESSOR_RUN)
          .find(span => span.name === "output stream processor: chat-channel-render");
        const agentSpan = exporter
          .getSpansByType(SpanType.AGENT_RUN)
          .find(span => span.name === "agent run: 'trace-probe'");

        expect(processorSpan).toBeDefined();
        expect(agentSpan).toBeDefined();
        expect(processorSpan?.traceId).toBe(externalParent.traceId);
        expect(processorSpan?.parentSpanId).toBe(agentSpan?.id);
      }, {
        timeout: 3_000,
        interval: 10,
      });

      const processorSpan = exporter
        .getSpansByType(SpanType.PROCESSOR_RUN)
        .find(span => span.name === "output stream processor: chat-channel-render")!;
      const spansById = new Map(
        exporter.getAllSpans().map(span => [span.id, span] as const),
      );
      const ancestorIds: string[] = [];
      const visited = new Set<string>();
      let ancestorId = processorSpan.parentSpanId;

      while (ancestorId && !visited.has(ancestorId)) {
        visited.add(ancestorId);
        ancestorIds.push(ancestorId);
        ancestorId = spansById.get(ancestorId)?.parentSpanId;
      }

      expect(ancestorIds).toContain(externalParent.id);
      expect(exporter.getRootSpans().some(span => span.id === processorSpan.id)).toBe(false);
    } finally {
      if (!externalParentEnded) externalParent.end();
      await mastra.shutdown();
    }
  });
});
