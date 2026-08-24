import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const skillsRoot = resolve(import.meta.dirname, "../../src/mastra/agents/qasey-main/skills");
const skillNames = [
  "qa-quick-query",
  "qa-review",
  "metersphere-case-management",
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

  it("keeps real MeterSphere writes owned by the deterministic Workflow", async () => {
    const source = await readFile(join(skillsRoot, "metersphere-case-management", "SKILL.md"), "utf8");
    expect(source).toContain("dry_run=true");
    expect(source).toContain("确定性 Workflow");
    expect(source).toMatch(/不得直接执行真实/u);
  });

  it("requires tool discovery for optional MeterSphere module operations", async () => {
    const source = await readFile(join(skillsRoot, "metersphere-case-management", "SKILL.md"), "utf8");
    expect(source).toContain("必须先调用 `search_tools`");
    expect(source).toContain("metersphere_ms_upsert_module");
    expect(source).toContain("不得声称“当前工具集没有该能力”");
  });

  it("does not create dedicated Skills for simple fallback intents", async () => {
    const entries = await readdir(skillsRoot);
    expect(entries).not.toContain("unknown-intent");
    expect(entries).not.toContain("meta-or-out-of-scope");
  });

});
