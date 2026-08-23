import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeWorkspaceSkills, resolveAgentSkills } from "@mastra/core/skills";
import { afterAll, describe, expect, it } from "vitest";
import { createTrustedRequestContext } from "../../src/platform/context/identity-resolver.ts";
import { createScopedWorkspace } from "../../src/platform/workspace/create-workspace.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../../src/platform/context/schema.ts";
import { GLOBAL_SKILLS_PATH, QASEY_MAIN_SKILLS_PATH } from "../../src/mastra/skill-paths.ts";

const root = mkdtempSync(join(tmpdir(), "shared-mastra-workspace-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("native scoped workspace", () => {
  it("reuses one path within a session and separates different owners", async () => {
    const workspace = createScopedWorkspace({ root, production: false, enableCodeExecution: false });
    const alpha = await workspace.resolveFilesystem({ requestContext: context("alpha", "tenant-a", "task-1", "run-1", "author") });
    const alphaFollowUp = await workspace.resolveFilesystem({ requestContext: context("alpha", "tenant-a", "task-2", "run-2", "verifier") });
    const beta = await workspace.resolveFilesystem({ requestContext: context("beta", "tenant-b", "task-1", "run-1", "verifier") });
    expect(alpha?.basePath).toContain("alpha/tenant-a/session");
    expect(alphaFollowUp?.basePath).toBe(alpha?.basePath);
    expect(beta?.basePath).toContain("beta/tenant-b/session");
    expect(alpha?.basePath).not.toBe(beta?.basePath);
    await workspace.close();
  });

  it("fails closed for production code execution when no remote sandbox is configured", async () => {
    const workspace = createScopedWorkspace({ root, production: true, enableCodeExecution: true });
    expect(workspace.hasSandboxConfig()).toBe(false);
    await expect(workspace.resolveSandbox({ requestContext: context("alpha", "tenant", "task", "run", "author") })).resolves.toBeUndefined();
    await workspace.close();
  });

  it("loads and merges global Workspace skills with qasey-main agent skills", async () => {
    const workspace = createScopedWorkspace({
      root,
      production: false,
      enableCodeExecution: false,
      skills: [GLOBAL_SKILLS_PATH],
    });
    const workspaceSkills = workspace.skills;
    expect(workspaceSkills).toBeDefined();

    const agentSkills = resolveAgentSkills([QASEY_MAIN_SKILLS_PATH]);
    expect((await workspaceSkills!.list()).map(skill => skill.name)).toContain("global-skill-smoke-test");
    expect((await workspaceSkills!.list()).map(skill => skill.name)).toContain("git-repository-workspace");
    expect((await agentSkills.list()).map(skill => skill.name)).toEqual(expect.arrayContaining([
      "qa-review",
      "metersphere-case-management",
    ]));

    const { merged } = await mergeWorkspaceSkills(agentSkills, workspaceSkills!);
    expect((await merged.list()).map(skill => skill.name)).toEqual(expect.arrayContaining([
      "global-skill-smoke-test",
      "git-repository-workspace",
      "qa-review",
      "metersphere-case-management",
    ]));
    expect((await merged.get("global-skill-smoke-test"))?.instructions).toContain("GLOBAL_WORKSPACE_SKILL_OK");
    expect((await merged.get("git-repository-workspace"))?.instructions).toContain("Search first");
    expect((await merged.get("git-repository-workspace"))?.instructions).toContain("verify/<run-id>");
    expect((await merged.get("qa-review"))?.instructions).toContain("QA 评审");
    expect((await merged.get("metersphere-case-management"))?.instructions).toContain("case_create_full");
    await workspace.close();
  });
});

function context(applicationId: string, tenantId: string, taskId: string, executionId: string, role: string) {
  return createTrustedRequestContext({
    requestId: `request-${executionId}`, applicationId, channel: "worker", ingressSource: "workflow",
    identity: { userId: "subject", tenantId, roles: [role], service: true }, sessionId: "session", taskId, executionId,
    [MASTRA_RESOURCE_ID_KEY]: `${applicationId}:${tenantId}:subject`,
    [MASTRA_THREAD_ID_KEY]: `${applicationId}:${tenantId}:private:session`,
  });
}
