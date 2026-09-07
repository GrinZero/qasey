import { describe, expect, it } from "vitest";
import { completedCodingOutput } from "../../packages/code-task/src/backend.ts";
import {
  codeTaskTraceIds,
  nativeCodingBackendPolicy,
  QASEY_E2E_CODE_AUTHOR_ID,
} from "../../packages/code-task/src/index.ts";

describe("native Mastra coding backend policy", () => {
  it("does not accept partial coding text after a provider stream disconnect", async () => {
    const failure = new Error("connection closed");
    await expect(completedCodingOutput({ getFullOutput: async () => ({ text: "Wrote tests", error: failure }) })).rejects.toBe(failure);
    await expect(completedCodingOutput({ getFullOutput: async () => ({ text: "Wrote tests", finishReason: "error" }) })).rejects.toThrow("before completion");
    await expect(completedCodingOutput({ getFullOutput: async () => ({ text: "Validated tests", runId: "author-run", finishReason: "stop" }) })).resolves.toMatchObject({ text: "Validated tests", runId: "author-run" });
  });
  it("accepts writes only inside frozen allowed paths", () => {
    const allowed = nativeCodingBackendPolicy.normalizeAllowedPaths(["./web/tests/e2e/", "web/pages"]);

    expect(nativeCodingBackendPolicy.isAllowedPath("web/tests/e2e/payment.spec.ts", allowed)).toBe(true);
    expect(nativeCodingBackendPolicy.isAllowedPath("web/pages/payment.ts", allowed)).toBe(true);
    expect(nativeCodingBackendPolicy.isAllowedPath("web/utils/secret.ts", allowed)).toBe(false);
    expect(nativeCodingBackendPolicy.isAllowedPath("../web/tests/e2e/escape.ts", allowed)).toBe(false);
    expect(nativeCodingBackendPolicy.isAllowedPath("/tmp/escape.ts", allowed)).toBe(false);
  });

  it("discovers Skill paths only from the frozen task brief", () => {
    const context = JSON.stringify({
      brief: { repository: { skillPaths: [".agents/skills", ".claude/skills"] } },
      instruction: "implement",
    });

    expect(nativeCodingBackendPolicy.taskSkillPaths(context)).toEqual([".agents/skills", ".claude/skills"]);
    expect(nativeCodingBackendPolicy.taskSkillPaths("not-json")).toEqual([]);
  });

  it("uses one stable E2E Agent identity and propagates valid W3C trace ids", () => {
    const traceId = "a".repeat(32);
    const parentSpanId = "b".repeat(16);

    expect(QASEY_E2E_CODE_AUTHOR_ID).toBe("qasey-e2e-author");
    expect(codeTaskTraceIds({ traceparent: `00-${traceId}-${parentSpanId}-01` })).toEqual({ traceId, parentSpanId });
    expect(codeTaskTraceIds({ traceId: "task-local-label" })).toBeUndefined();
  });
});
