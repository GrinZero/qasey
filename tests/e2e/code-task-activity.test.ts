import { expect, it } from "vitest";
import { codeTaskActivity } from "../../packages/e2e/src/code-task-activity.ts";
import type { CodeTaskEvent } from "../../packages/contracts/src/index.ts";
const event: CodeTaskEvent = { cursor: "1", taskId: "public-run:author:0", at: "2026-09-06T00:00:00.000Z", type: "agent.trace.span_ended", message: "private raw log", metadata: {} };
it("projects a real tool span without copying trace payloads", () => {
  const metadata = { attemptId: "attempt-one", mastraTraceEvent: { type: "span_ended", exportedSpan: { type: "tool_call", id: "span-one", name: "mastra_workspace_read_file", input: { secret: "do not expose" }, output: "private file contents", attributes: { success: true } } } };
  expect(codeTaskActivity({ ...event, metadata })).toEqual({ id: "public-run:author:0:attempt-one:span-one", name: "mastra_workspace_read_file", title: "读取文件", status: "completed" });
  expect(codeTaskActivity({ ...event, metadata: { mastraTraceEvent: { type: "span_ended", exportedSpan: { type: "model_generation", name: "model" } } } })).toBeUndefined();
});
it("keeps check failures distinct from running checks", () => {
  expect(codeTaskActivity({ ...event, type: "check.started", metadata: { checkId: "playwright" } })?.status).toBe("running");
  expect(codeTaskActivity({ ...event, type: "check.completed", metadata: { checkId: "playwright", exitCode: 1 } })?.status).toBe("failed");
});

it.each(["entityId", "entityName"])("uses native Mastra %s with a decorated display name", field => {
  const span = {
    id: "native-tool-span", type: "tool_call", name: "tool: 'mastra_workspace_read_file'",
    [field]: "mastra_workspace_read_file",
    attributes: { toolDescription: "private description", toolType: "tool", toolCallId: "native-call" },
    input: { path: "private/path" }, output: "private contents",
  };
  const activity = (type: string, exportedSpan = span) => codeTaskActivity({ ...event, metadata: {
    attemptId: "attempt-one", mastraTraceEvent: { type, exportedSpan },
  } });
  expect(activity("span_started")).toEqual({ id: "public-run:author:0:attempt-one:native-tool-span", name: "mastra_workspace_read_file", title: "读取文件", status: "running" });
  expect(activity("span_ended")?.status).toBe("completed");
  expect(JSON.stringify(activity("span_ended"))).not.toContain("private");
  expect(activity("span_ended", { ...span, [field]: "invalid 'identifier'" })).toBeUndefined();
});
