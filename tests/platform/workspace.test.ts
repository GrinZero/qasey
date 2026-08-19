import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTrustedRequestContext } from "../../src/platform/context/identity-resolver.ts";
import { createScopedWorkspace } from "../../src/platform/workspace/create-workspace.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../../src/platform/context/schema.ts";

const root = mkdtempSync(join(tmpdir(), "shared-mastra-workspace-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("native scoped workspace", () => {
  it("separates application, tenant, task, execution, and role paths", async () => {
    const workspace = createScopedWorkspace({ root, production: false, enableCodeExecution: false });
    const alpha = await workspace.resolveFilesystem({ requestContext: context("alpha", "tenant-a", "task-1", "run-1", "author") });
    const beta = await workspace.resolveFilesystem({ requestContext: context("beta", "tenant-b", "task-1", "run-1", "verifier") });
    expect(alpha?.basePath).toContain("alpha/tenant-a/task-1/run-1/author");
    expect(beta?.basePath).toContain("beta/tenant-b/task-1/run-1/verifier");
    expect(alpha?.basePath).not.toBe(beta?.basePath);
    await workspace.close();
  });

  it("fails closed for production code execution when no remote sandbox is configured", async () => {
    const workspace = createScopedWorkspace({ root, production: true, enableCodeExecution: true });
    expect(workspace.hasSandboxConfig()).toBe(false);
    await expect(workspace.resolveSandbox({ requestContext: context("alpha", "tenant", "task", "run", "author") })).resolves.toBeUndefined();
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
