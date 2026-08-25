import "../load-env.ts";
import type { DatadogBridge } from "@mastra/datadog";
import {
  fallbackTraceCarrier,
  normalizeDatadogTraceCarrier,
  type DatadogTraceCarrier,
} from "./applications/qasey/trace-carrier.ts";

export const datadogEnabled = process.env.QASEY_ENABLE_DATADOG === "true";

export type DatadogTracer = typeof import("dd-trace")["default"];
export const datadogTracerSymbol = Symbol.for("qasey.datadog.tracer");

let datadogTracer: DatadogTracer | undefined;
let datadogContextBridge: Pick<DatadogBridge, "executeInContextSync"> | undefined;
if (datadogEnabled) {
  // Keep dd-trace completely out of the default development/runtime path.
  // Mastra's dependency optimizer cannot safely copy dd-trace's internal
  // plugin layout when the package is loaded but tracing is disabled.
  const { default: tracer } = await import("dd-trace");
  tracer.init({
    service: process.env.DD_SERVICE?.trim() || "qasey",
    env: process.env.DD_ENV?.trim() || process.env.NODE_ENV || "development",
    ...(process.env.DD_VERSION?.trim() ? { version: process.env.DD_VERSION.trim() } : {}),
    logInjection: true,
    runtimeMetrics: true,
  });
  datadogTracer = tracer;
  (globalThis as typeof globalThis & Record<symbol, unknown>)[datadogTracerSymbol] = tracer;
}

export function registerDatadogContextBridge(
  bridge: Pick<DatadogBridge, "executeInContextSync"> | undefined,
): void {
  datadogContextBridge = bridge;
}

export function createDatadogTraceCarrier(
  spanId: string,
  traceId: string,
): DatadogTraceCarrier {
  const fallback = fallbackTraceCarrier(traceId, spanId);
  if (!datadogTracer || !datadogContextBridge) return fallback;
  try {
    return datadogContextBridge.executeInContextSync(spanId, () => {
      const activeSpan = datadogTracer?.scope().active();
      if (!activeSpan || !datadogTracer) return fallback;
      const carrier: Record<string, unknown> = {};
      datadogTracer.inject(activeSpan.context(), "text_map", carrier);
      return normalizeDatadogTraceCarrier(carrier) ?? fallback;
    });
  } catch {
    return fallback;
  }
}

export async function runWithDatadogTraceCarrier<T>(
  carrier: DatadogTraceCarrier | undefined,
  options: { name: string; sessionId?: string },
  operation: () => Promise<T>,
): Promise<T> {
  if (!carrier || !datadogTracer) return operation();
  const parent = datadogTracer.extract("text_map", carrier);
  if (!parent) return operation();
  if (datadogTracer.llmobs.enabled) {
    return datadogTracer.llmobs.trace({
      name: options.name,
      kind: "workflow",
      childOf: parent,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    }, () => operation());
  }
  return datadogTracer.trace(options.name, { childOf: parent }, () => operation());
}

export { datadogTracer };
