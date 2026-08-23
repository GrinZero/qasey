import { describe, expect, it, vi } from "vitest";
import { InMemoryRunRepository } from "../../packages/domain/src/index.ts";
import { CreateE2ERunSchema } from "../../packages/contracts/src/index.ts";
import { E2ECoordinator, type ArtifactStore, type CodingHarness, type DraftPrBroker, type E2ERunner, type WorkspaceManager, type WorkspaceRef } from "../../packages/e2e/src/index.ts";

describe("E2E coordinator", () => {
  it("rejects client-supplied dependency commands", () => {
    expect(CreateE2ERunSchema.safeParse({
      sourceSessionId: "s",
      sourceCaseIds: ["case-1"],
      platform: "web",
      framework: "playwright",
      repository: {
        owner: "o",
        repository: "r",
        cloneUrl: "https://example.test/r.git",
        baseRef: "main",
        allowedPaths: ["e2e"],
        skillsPaths: [],
        installCommand: ["sh", "-c", "echo unsafe"],
      },
    }).success).toBe(false);
  });

  it("requires an author pass and an independent verifier pass before a Draft PR", async () => {
    const owner = { applicationId: "qasey", tenantId: "tenant-1" };
    const repository = new InMemoryRunRepository();
    const createdWorkspaces: WorkspaceRef[] = [];
    const workspaces: WorkspaceManager = {
      create: vi.fn(async (profile, id, options) => {
        const ref: WorkspaceRef = {
          id,
          root: `/isolated/${id}`,
          gitDir: `/isolated/${id}/store.git`,
          branch: options?.branch ?? `qasey/${id}`,
          baseSha: options?.baseSha ?? "0123456789abcdef0123456789abcdef01234567",
          purpose: options?.purpose ?? "author",
          repository: profile,
        };
        createdWorkspaces.push(ref);
        return ref;
      }),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })),
      collectPatch: vi.fn(async () => "diff --git a/e2e/a.spec.ts b/e2e/a.spec.ts"),
      changedPaths: vi.fn(async () => ["e2e/a.spec.ts"]),
      assertAllowedChanges: vi.fn(async () => undefined),
      assertWritablePath: vi.fn(async () => undefined),
      applyPatch: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    };
    const harness: CodingHarness = { author: vi.fn(async () => ({ summary: "generated" })) };
    const phases: string[] = [];
    const runner: E2ERunner = {
      framework: "playwright",
      run: vi.fn(async workspace => { phases.push(workspace.id); return { passed: true, exitCode: 0, summary: "passed", artifacts: [] }; }),
    };
    const artifacts: ArtifactStore = {
      savePatch: vi.fn(async (_owner, runId) => ({ id: `${runId}:patch`, kind: "patch" as const, name: "changes.patch", uri: "file:///artifact.patch" })),
      loadPatch: vi.fn(async () => "patch"),
      persist: vi.fn(async (_owner, _runId, _phase, refs) => refs),
    };
    let markedReady = false;
    const broker: DraftPrBroker = {
      publish: vi.fn(async () => "https://github.com/o/r/pull/1"),
      markReady: vi.fn(async () => { markedReady = true; }),
    };
    const coordinator = new E2ECoordinator(repository, workspaces, harness, { playwright: runner, maestro: { ...runner, framework: "maestro" } }, artifacts, broker, false, { maxRepairs: 2, reviewBaseUrl: "https://qasey.test" });
    const run = await coordinator.create(owner, {
      sourceSessionId: "s", sourceCaseIds: ["case-1"], platform: "web", framework: "playwright",
      repository: { owner: "o", repository: "r", cloneUrl: "https://example.test/r.git", baseRef: "main", allowedPaths: ["e2e"], skillsPaths: [] },
    });
    await coordinator.execute(owner, run.id);
    expect(createdWorkspaces).toHaveLength(2);
    expect(phases[0]).toContain("author");
    expect(phases[1]).toContain("verifier");
    expect(broker.publish).toHaveBeenCalledTimes(1);
    expect(await repository.get(owner, run.id)).toMatchObject({ status: "awaiting_qa", pullRequestUrl: "https://github.com/o/r/pull/1" });
    await coordinator.verdict(owner, run.id, { verdict: "approve", reviewerId: "qa-1" });
    expect(markedReady).toBe(true);
    expect(await repository.get(owner, run.id)).toMatchObject({ status: "succeeded" });
  });
});
