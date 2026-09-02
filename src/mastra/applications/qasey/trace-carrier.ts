import { z } from "zod";

const HexTraceIdSchema = z.string().regex(/^[a-f0-9]{1,32}$/u);
const HexSpanIdSchema = z.string().regex(/^[a-f0-9]{1,16}$/u);

export const DatadogTraceCarrierSchema = z.object({
  traceparent: z.string().regex(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/u).optional(),
  tracestate: z.string().min(1).max(512).optional(),
  baggage: z.string().min(1).max(2_048).optional(),
  "x-datadog-trace-id": z.string().regex(/^\d{1,20}$/u).optional(),
  "x-datadog-parent-id": z.string().regex(/^\d{1,20}$/u).optional(),
  "x-datadog-sampling-priority": z.string().regex(/^-?\d+$/u).optional(),
  "x-datadog-origin": z.string().min(1).max(100).optional(),
  "x-datadog-tags": z.string().min(1).max(1_024).optional(),
}).strict();

export type DatadogTraceCarrier = z.infer<typeof DatadogTraceCarrierSchema>;

export const QaseyRemoteTraceContextSchema = z.object({
  traceId: HexTraceIdSchema,
  parentSpanId: HexSpanIdSchema,
  carrier: DatadogTraceCarrierSchema.optional(),
}).strict();

export type QaseyRemoteTraceContext = z.infer<typeof QaseyRemoteTraceContextSchema>;

export function fallbackTraceCarrier(traceId: string, spanId: string): DatadogTraceCarrier {
  const normalizedTraceId = HexTraceIdSchema.parse(traceId).padStart(32, "0");
  const normalizedSpanId = HexSpanIdSchema.parse(spanId).padStart(16, "0");
  return { traceparent: `00-${normalizedTraceId}-${normalizedSpanId}-01` };
}

export function normalizeDatadogTraceCarrier(carrier: Record<string, unknown>): DatadogTraceCarrier | undefined {
  const normalized = Object.fromEntries(
    Object.entries(carrier).flatMap(([key, value]) => {
      if (typeof value !== "string" && typeof value !== "number") return [];
      return [[key.toLowerCase(), String(value)]];
    }),
  );
  const parsed = DatadogTraceCarrierSchema.safeParse(normalized);
  return parsed.success ? parsed.data : undefined;
}
