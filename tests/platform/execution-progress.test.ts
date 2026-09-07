import { expect, it } from "vitest";
import { groupExecutionMessages, executionHeadline } from "../../apps/admin-ui/src/components/execution-progress.ts";
import type { QaseyUIMessage } from "../../packages/contracts/src/index.ts";

const message = (id: string, runId: string, kind = "execution", text = id) => ({ id, role: "assistant", metadata: { linkedRunId: runId, messageKind: kind }, parts: [{ type: "text", text }] }) as QaseyUIMessage;

it("groups interleaved runs without swallowing narrative or changing each run's anchor", () => {
  const input = [message("a", "one"), message("b", "two"), message("analysis", "one", "message"), message("c", "one")];
  const groups = groupExecutionMessages(input);
  expect([...groups.values()].map(group => group.map(item => item.id))).toEqual([["a", "c"], ["b"]]);
  expect(input).toHaveLength(4);
  expect(groupExecutionMessages([...input, message("d", "one")]).get("one")?.[0]?.id).toBe("a");
});

it("does not show historical raw errors or attachment links as the progress headline", () => {
  expect(executionHeadline(message("a", "one", "execution", "执行失败。raw error\n[trace.zip](/trace)"))).toBe("执行失败");
  expect(executionHeadline(message("a", "one", "execution", "正在验证\n[report](/report)"))).toBe("正在验证");
  expect(executionHeadline(undefined)).toBe("等待执行进度");
});
