import type { ToolsInput } from "@mastra/core/agent";

interface SchemaIssue {
  path: string;
  pattern: string;
}

const UNSUPPORTED_OPENAI_REGEX = /\(\?(?:[=!]|<[=!])|\\(?:[1-9]|k<)/u;

/**
 * MCP schemas are already enforced by the remote server. Remove regex features
 * that OpenAI cannot compile while retaining every provider-compatible keyword.
 */
export function sanitizeOpenAIToolInputSchema<T>(schema: T): T {
  return sanitizeNode(schema).value as T;
}

/** Fail before a model request if any final tool still contains an unsupported regex. */
export function assertOpenAICompatibleToolSchemas(tools: ToolsInput): void {
  const failures = Object.entries(tools).flatMap(([toolName, tool]) => {
    const inputSchema = "inputSchema" in tool ? tool.inputSchema : undefined;
    return findUnsupportedOpenAIRegexPatterns(toJsonSchema(inputSchema)).map(issue => ({ toolName, ...issue }));
  });
  if (failures.length === 0) return;
  throw new Error(`OpenAI-incompatible tool schemas: ${failures
    .map(({ toolName, path }) => `${toolName}${path}`)
    .join(", ")}`);
}

export function findUnsupportedOpenAIRegexPatterns(schema: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  visit(schema, "$", issues);
  return issues;
}

function toJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const standard = (schema as { "~standard"?: {
    jsonSchema?: { input?: (options: { target: "draft-07" }) => unknown };
  } })["~standard"];
  return standard?.jsonSchema?.input?.({ target: "draft-07" }) ?? schema;
}

function visit(value: unknown, path: string, issues: SchemaIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, issues));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === "pattern" && typeof child === "string" && UNSUPPORTED_OPENAI_REGEX.test(child)) {
      issues.push({ path: childPath, pattern: child });
      continue;
    }
    visit(child, childPath, issues);
  }
}

function sanitizeNode(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map(item => {
      const sanitized = sanitizeNode(item);
      changed ||= sanitized.changed;
      return sanitized.value;
    });
    return changed ? { value: output, changed } : { value, changed };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "pattern" && typeof child === "string" && UNSUPPORTED_OPENAI_REGEX.test(child)) {
      changed = true;
      continue;
    }
    const sanitized = sanitizeNode(child);
    changed ||= sanitized.changed;
    output[key] = sanitized.value;
  }
  return changed ? { value: output, changed } : { value, changed };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
