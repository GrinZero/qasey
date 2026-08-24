import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("Slack environment manifests", () => {
  it("registers /qasey-local only in the testing App", async () => {
    const [devops, testing] = await Promise.all([
      readFile(resolve(root, "deploy/slack/manifest.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, "deploy/slack/manifest.testing.json"), "utf8").then(JSON.parse),
    ]);
    expect(devops.features.slash_commands).toBeUndefined();
    expect(devops.oauth_config.scopes.bot).not.toContain("commands");
    expect(testing.features.slash_commands).toEqual([
      expect.objectContaining({
        command: "/qasey-local",
        url: "https://qasey.t2.moego.dev/studio/api/agents/qasey-main/channels/slack/webhook",
      }),
    ]);
    expect(testing.oauth_config.scopes.bot).toContain("commands");
  });
});
