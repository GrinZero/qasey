import { describe, expect, it } from "vitest";
import { authorizeToolCall, sanitizeIntentRoute, TOOL_POLICIES } from "../../packages/domain/src/index.ts";

describe("intent and side-effect policy", () => {
  it("recomputes write targets instead of trusting model output", () => {
    const route = sanitizeIntentRoute({ version: 2, intent: "qa_review", relation: "new", writeTarget: "git", depth: "deep", confidence: 1, reason: "x", routerStatus: "ok" });
    expect(route.writeTarget).toBe("none");
  });

  it("keeps evidence researchers read-only", () => {
    const route = sanitizeIntentRoute({ version: 2, intent: "case_create_full", relation: "new", writeTarget: "metersphere", depth: "deep", confidence: 1, reason: "test", routerStatus: "ok" });
    expect(() => authorizeToolCall("metersphere_write", TOOL_POLICIES.metersphere_write!, { channel: "slack", route, subagentRole: "evidence_researcher" })).toThrow(/read-only/);
  });

  it("requires explicit approval for QA experience writes", () => {
    const route = sanitizeIntentRoute({ version: 2, intent: "experience_write", relation: "new", writeTarget: "qa_experience", depth: "standard", confidence: 1, reason: "test", routerStatus: "ok" });
    expect(() => authorizeToolCall("qa_experience_write", TOOL_POLICIES.qa_experience_write!, { channel: "slack", route })).toThrow(/explicit approval/);
    expect(() => authorizeToolCall("qa_experience_write", TOOL_POLICIES.qa_experience_write!, { channel: "slack", route, approved: true })).not.toThrow();
  });
});
