export function externalWriteIdempotencyKey(input: {
  applicationId: string;
  tenantId: string;
  workflowId: string;
  runId: string;
  effect: string;
}): string {
  const values = Object.values(input).map(value => value.trim());
  if (values.some(value => !value)) throw new Error("Idempotency key parts must be non-empty");
  return values.map(value => encodeURIComponent(value)).join(":");
}

/** Fail before a workflow snapshot contains process-bound or oversized state. */
export function assertJsonSafeSnapshot(value: unknown, maxBytes = 256 * 1024): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Snapshot byte limit must be positive");
  const seen = new Set<object>();
  visit(value, "$", seen);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Workflow snapshot must be JSON serializable");
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxBytes) throw new Error(`Workflow snapshot is ${bytes} bytes; limit is ${maxBytes}`);
}

function visit(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Workflow snapshot contains a non-finite number at ${path}`);
    return;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") {
    throw new Error(`Workflow snapshot contains a non-JSON value at ${path}`);
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`Workflow snapshot contains a cycle at ${path}`);
  if (value instanceof Date || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) {
    throw new Error(`Workflow snapshot contains a process-specific object at ${path}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw new Error(`Workflow snapshot contains a class instance at ${path}`);
  }
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`, seen));
  else for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`, seen);
  seen.delete(value);
}
