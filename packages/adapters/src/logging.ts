export type LogFields = Record<string, string | number | boolean | null | undefined>;

const datadogTracerSymbol = Symbol.for("qasey.datadog.tracer");

interface ActiveDatadogTracer {
  scope(): { active(): { context(): { toTraceId(): string; toSpanId(): string } } | null };
}

export function logInfo(event: string, fields: LogFields = {}): void {
  console.info(JSON.stringify(compact("info", event, fields)));
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  console.error(JSON.stringify(compact("error", event, {
    ...fields,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : String(error),
  })));
}

function compact(level: "info" | "error", event: string, fields: LogFields): Record<string, string | number | boolean | null> {
  const tracer = (globalThis as typeof globalThis & Record<symbol, unknown>)[datadogTracerSymbol] as ActiveDatadogTracer | undefined;
  const activeContext = tracer?.scope().active()?.context();
  const output: Record<string, string | number | boolean | null> = {
    timestamp: new Date().toISOString(),
    level,
    service: "qasey",
    event,
    ...(activeContext ? {
      "dd.trace_id": activeContext.toTraceId(),
      "dd.span_id": activeContext.toSpanId(),
    } : {}),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}
