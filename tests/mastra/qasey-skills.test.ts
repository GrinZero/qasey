import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const skillsRoot = resolve(import.meta.dirname, "../../src/mastra/agents/qasey-main/skills");
const skillNames = [
  "qa-quick-query",
  "qa-review",
  "qa-experience",
  "e2e-lifecycle",
] as const;

describe("qasey-main intent Skills", () => {
  it.each(skillNames)("loads %s without a runtime intent registration protocol", async skillName => {
    const source = await readFile(join(skillsRoot, skillName, "SKILL.md"), "utf8");
    expect(source).toContain(`name: ${skillName}`);
    expect(source).toContain("description:");
    expect(source).not.toContain("qasey_select_task_mode");
  });

  it("keeps Case Hub writes behind an immutable change set", async () => {
    const source = await readFile(join(skillsRoot, "e2e-lifecycle", "SKILL.md"), "utf8");
    expect(source).toContain("`case_hub_create_change_set`");
    expect(source).toContain("Case Hub");
  });

  it("does not create dedicated Skills for simple fallback intents", async () => {
    const entries = await readdir(skillsRoot);
    expect(entries).not.toContain("unknown-intent");
    expect(entries).not.toContain("meta-or-out-of-scope");
  });

});
