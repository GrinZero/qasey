import type { CodeTaskEvent } from "../../contracts/src/index.ts";
import type { ExecutionToolCall } from "../../contracts/src/collaboration.ts";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Project only tool identity and lifecycle. Trace input/output and error logs stay private. */
export function codeTaskActivity(event: CodeTaskEvent): ExecutionToolCall | undefined {
  const trace = record(event.metadata.mastraTraceEvent);
  const span = record(trace.exportedSpan);
  const attributes = record(span.attributes);
  const check = event.type === "check.started" || event.type === "check.completed";
  if (!check && span.type !== "tool_call" && span.type !== "mcp_tool_call") return;
  if (!check && !["span_started", "span_ended"].includes(String(trace.type))) return;
  // Mastra tool spans identify the tool on the entity; their display name is
  // decorated (tool: '...') and must not be treated as a tool identifier.
  const name = check ? event.metadata.checkId : attributes.toolId ?? attributes.toolName ?? span.entityId ?? span.entityName ?? span.name;
  if (typeof name !== "string" || !/^[\w .:/-]{1,160}$/u.test(name)) return;
  const finished = check ? event.type === "check.completed" : trace.type === "span_ended";
  const failed = check ? event.metadata.exitCode !== 0 : attributes.success === false || Boolean(span.errorInfo);
  const title = /read_file|read-file/u.test(name) ? "读取文件" : /write_file|write-file/u.test(name) ? "编写文件"
    : /edit|ast_edit/u.test(name) ? "修改代码" : /search|grep/u.test(name) ? "搜索代码"
    : /list|glob/u.test(name) ? "查看目录" : /validate.*candidate/u.test(name) ? "验证测试实现"
    : name === "repo-install" ? "安装依赖" : name === "playwright" ? "运行浏览器测试"
    : name === "playwright-discovery" ? "检查测试发现" : "调用工具";
  return {
    id: `${event.taskId}:${String(event.metadata.attemptId ?? "")}:${check ? name : String(span.id)}`,
    name, title, status: finished ? failed ? "failed" : "completed" : "running",
  };
}
