import { describe, expect, it } from "vitest";
import { nativeCodingBackendPolicy } from "../../packages/code-task/src/index.ts";

describe("native Mastra coding backend policy", () => {
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
});
