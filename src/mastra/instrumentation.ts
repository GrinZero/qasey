export const datadogEnabled = process.env.QASEY_ENABLE_DATADOG === "true";

export type DatadogTracer = typeof import("dd-trace")["default"];
export const datadogTracerSymbol = Symbol.for("qasey.datadog.tracer");

let datadogTracer: DatadogTracer | undefined;
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

export { datadogTracer };
