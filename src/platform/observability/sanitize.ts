const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|email|attachment|prompt|body|content)/iu;

export function sanitizeTelemetry(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeTelemetry(item, depth + 1));
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    SENSITIVE_KEY.test(key) ? [[key, "[redacted]"]] : [[key, sanitizeTelemetry(item, depth + 1)]],
  ));
}
