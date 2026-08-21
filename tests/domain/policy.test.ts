import { describe, expect, it } from "vitest";
import { authorizeDiscoveredToolAccess, TOOL_POLICIES } from "../../packages/domain/src/index.ts";

describe("intent-independent side-effect policy", () => {
  it("rejects tools outside their allowed channel", () => {
    expect(() => authorizeDiscoveredToolAccess(
      "qa_experience_write",
      TOOL_POLICIES.qa_experience_write!,
      { channel: "jira" },
    )).toThrow(/not available on jira/i);
  });

  it("keeps evidence researchers read-only", () => {
    expect(() => authorizeDiscoveredToolAccess(
      "metersphere_write",
      TOOL_POLICIES.metersphere_write!,
      { channel: "slack", subagentRole: "evidence_researcher" },
    )).toThrow(/read-only/);
  });

  it("keeps approval metadata independent from semantic intent", () => {
    expect(TOOL_POLICIES.qa_experience_write).toMatchObject({
      effect: "write",
      allowedChannels: ["slack"],
      requiresApproval: true,
    });
  });
});
