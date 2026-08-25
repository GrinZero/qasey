import { describe, expect, it } from "vitest";
import { buildSlackChatInput } from "../../src/mastra/applications/qasey/channels.ts";

describe("Slack Agent input", () => {
  it("preserves canonical rich-link URLs, including hash-route parameters", () => {
    const url = "https://metersphere.devops.moego.pet/#/track/case/all?projectId=project-1&moduleId=module-1";

    expect(buildSlackChatInput("这个链接", [{ url }])).toBe(`这个链接\n\nLinks:\n${url}`);
  });

  it("keeps plain Slack messages unchanged", () => {
    expect(buildSlackChatInput("没有链接", [])).toBe("没有链接");
  });
});
