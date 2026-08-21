import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { buildSystemPrompt } from "../../packages/domain/src/index.ts";

interface PromptCapability {
  id: string;
  expectedText: string;
}

const baseline = JSON.parse(readFileSync(
  new URL("../../n8n/fixtures/qasey-live-v6.manifest.json", import.meta.url),
  "utf8",
)) as {
  activeVersionId: string;
  requiredCodePromptCapabilities: PromptCapability[];
};

const context: QaseyRequestContext = {
  requestId: "parity-check",
  channel: "slack",
  sessionId: "slack-thread",
  chatInput: "帮我写这个需求的 case",
  actor: { id: "qa" },
  source: { channelId: "C1", threadTs: "1.0" },
  attachments: [],
};

describe(`n8n prompt parity (${baseline.activeVersionId})`, () => {
  const prompt = [
    buildSystemPrompt(context).text,
    readFileSync(new URL("../../src/mastra/agents/qasey-main/skills/metersphere-case-management/SKILL.md", import.meta.url), "utf8"),
  ].join("\n\n");

  it.each(baseline.requiredCodePromptCapabilities)("keeps $id", ({ expectedText }) => {
    expect(prompt).toContain(expectedText);
  });
});
