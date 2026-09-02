const ALWAYS_SENSITIVE_KEY = /(?:authorization|cookie|secret|password|email|attachment)/iu;
const TOKEN_KEY = /token/iu;
const MODEL_CONTENT_KEY = /(?:prompt|body|content)/iu;

export interface TelemetrySanitizeOptions {
  captureModelContent?: boolean;
}

function shouldRedact(key: string, value: unknown, captureModelContent: boolean): boolean {
  if (ALWAYS_SENSITIVE_KEY.test(key)) return true;
  // Token usage is telemetry, while string/object token values may be credentials.
  if (TOKEN_KEY.test(key)) return typeof value !== "number";
  return !captureModelContent && MODEL_CONTENT_KEY.test(key);
}

function sanitizeTelemetryValue(
  value: unknown,
  options: TelemetrySanitizeOptions,
  depth: number,
  modelContentScope: boolean,
): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeTelemetryValue(item, options, depth + 1, modelContentScope));
  }
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const childModelContentScope = modelContentScope
      || (depth === 0 && options.captureModelContent === true && (key === "input" || key === "output"));
    return shouldRedact(key, item, childModelContentScope)
      ? [key, "[redacted]"]
      : [key, sanitizeTelemetryValue(item, options, depth + 1, childModelContentScope)];
  }));
}

export function sanitizeTelemetry(value: unknown, options: TelemetrySanitizeOptions = {}): unknown {
  return sanitizeTelemetryValue(value, options, 0, false);
}
