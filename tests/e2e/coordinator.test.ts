import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InvalidRunTransitionError, InMemoryRunRepository, RunRevisionConflictError } from "../../packages/domain/src/index.ts";
import {
  CreateE2ERunRequestSchema,
  CreateE2ERunSchema,
  E2ERunSchema,
  type ArtifactRef,
  type CodeTaskResult,
  type CodeTaskSpec,
} from "../../packages/contracts/src/index.ts";
import type { CodeTaskRunner, CodeTaskRunnerProvider } from "../../packages/code-task/src/index.ts";
import { E2ECoordinator, type ArtifactStore, type DraftPrBroker } from "../../packages/e2e/src/index.ts";

const sha = "a".repeat(64);
const baseSha = "b".repeat(40);

describe("E2E coordinator", () => {
  it("rejects client-supplied dependency commands", () => {
    expect(CreateE2ERunSchema.safeParse({
      sourceSessionId: "s",
      changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff",
      handoff: handoff(),
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
      playwrightVerification,
    }).success).toBe(false);
  });

  it("keeps the target repository server-owned at the public boundary", () => {
    expect(CreateE2ERunRequestSchema.safeParse({
      changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff", handoff: handoff(), platform: "web", framework: "playwright",
      repository: { owner: "attacker", repository: "arbitrary" },
    }).success).toBe(false);
    expect(CreateE2ERunRequestSchema.safeParse({
      changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff", handoff: handoff(), platform: "web", framework: "playwright",
      playwrightVerification,
    }).success).toBe(false);
    expect(CreateE2ERunRequestSchema.safeParse({
      changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff", handoff: handoff(), platform: "web", framework: "playwright",
      testEnvironment: { id: "attacker", baseUrl: "https://attacker.example" },
    }).success).toBe(false);
  });

  it("requires trusted verification when a server creates a new run", () => {
    const { playwrightVerification: _verification, ...missingVerification } = createInput();
    expect(CreateE2ERunSchema.safeParse(missingVerification).success).toBe(false);
  });

  it("enforces the create schema inside the coordinator at runtime", async () => {
    const owner = { applicationId: "qasey", tenantId: "tenant-1" };
    const coordinator = new E2ECoordinator(new InMemoryRunRepository(), artifacts(), broker(), {
      maxRepairs: 2,
      reviewBaseUrl: "https://qasey.test",
      codeTasks: { forScope: vi.fn(async () => fakeRunner([])) },
    });
    const { playwrightVerification: _verification, ...missingVerification } = createInput();

    await expect(coordinator.create(owner, missingVerification as unknown as Parameters<typeof coordinator.create>[1]))
      .rejects.toThrow(/playwrightVerification/u);
  });

  it("requires a canonical Change Set id", () => {
    const base = { handoff: handoff(), platform: "web", framework: "playwright" };
    expect(CreateE2ERunRequestSchema.safeParse({ ...base, changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff" }).success).toBe(true);
    expect(CreateE2ERunRequestSchema.safeParse({ ...base, changeSetId: "not-a-change-set" }).success).toBe(false);
  });

  it("fails before creating an orphaned queued run when CodeTask execution is unavailable", async () => {
    const repository = new InMemoryRunRepository();
    const coordinator = new E2ECoordinator(repository, artifacts(), broker(), {
      maxRepairs: 2,
      reviewBaseUrl: "https://qasey.test",
    });
    await expect(coordinator.create({ applicationId: "qasey", tenantId: "tenant-1" }, createInput()))
      .rejects.toThrow(/CodeTask Runner is not configured/);
  });

  it("defaults legacy run payloads to the first optimistic revision", async () => {
    const owner = { applicationId: "qasey", tenantId: "tenant-1" };
    const coordinator = new E2ECoordinator(new InMemoryRunRepository(), artifacts(), broker(), {
      maxRepairs: 2,
      reviewBaseUrl: "https://qasey.test",
      codeTasks: { forScope: vi.fn(async () => fakeRunner([])) },
    });
    const created = await coordinator.create(owner, createInput());
    const legacyPayload = { ...created } as Record<string, unknown>;
    delete legacyPayload.revision;

    expect(E2ERunSchema.parse(legacyPayload).revision).toBe(1);
  });

  it("rejects a stale writer instead of silently overwriting a newer run revision", async () => {
    const owner = { applicationId: "qasey", tenantId: "tenant-1" };
    const repository = new InMemoryRunRepository();
    const coordinator = new E2ECoordinator(repository, artifacts(), broker(), {
      maxRepairs: 2,
      reviewBaseUrl: "https://qasey.test",
      codeTasks: { forScope: vi.fn(async () => fakeRunner([])) },
    });
    const original = await coordinator.create(owner, createInput());
    const updated = await repository.update(owner, original.id, original.revision, { status: "failed" });

    expect(updated.revision).toBe(2);
    const conflict = await repository.update(owner, original.id, original.revision, { branch: "stale-writer" }).catch(error => error);
    expect(conflict).toBeInstanceOf(RunRevisionConflictError);
    expect(conflict).toMatchObject({
      name: "RunRevisionConflictError",
      code: "run_revision_conflict",
      runId: original.id,
      expectedRevision: 1,
      actualRevision: 2,
    });
    await expect(repository.get(owner, original.id)).resolves.toMatchObject({ status: "failed", revision: 2 });
  });

  it("rejects status regression from a terminal run", async () => {
    const owner = { applicationId: "qasey", tenantId: "tenant-1" };
    const repository = new InMemoryRunRepository();
    const coordinator = new E2ECoordinator(repository, artifacts(), broker(), {
      maxRepairs: 2,
      reviewBaseUrl: "https://qasey.test",
      codeTasks: { forScope: vi.fn(async () => fakeRunner([])) },
    });
    const original = await coordinator.create(owner, createInput());
    const failed = await repository.update(owner, original.id, original.revision, { status: "failed" });

    const invalidTransition = await repository.update(owner, failed.id, failed.revision, { status: "authoring" }).catch(error => error);
    expect(invalidTransition).toBeInstanceOf(InvalidRunTransitionError);
    expect(invalidTransition).toMatchObject({
      name: "InvalidRunTransitionError",
      code: "invalid_run_transition",
      from: "failed",
      to: "authoring",
    });
    await expect(repository.get(owner, original.id)).resolves.toMatchObject({ status: "failed", revision: 2 });
  });

  it("completes the one-Case happy path from Sandbox author through approval and Ready PR", async () => {
    const owner = { applicationId: "qasey", tenantId: "tenant-1" };
    const repository = new InMemoryRunRepository();
    const submitted: CodeTaskSpec[] = [];
    const submittedSecrets: Array<Readonly<Record<string, string>> | undefined> = [];
    const runner = fakeRunner(submitted, submittedSecrets);
    const draftPr = broker();
    const authenticationSecrets = {
      resolve: vi.fn(async () => ({
        E2E_LOGIN_EMAIL: "operator@example.test",
        E2E_LOGIN_PASSWORD: "redacted-password",
      })),
    };
    const coordinator = new E2ECoordinator(repository, artifacts(), draftPr, {
      maxRepairs: 2,
      reviewBaseUrl: "https://qasey.test",
      codeTasks: { forScope: vi.fn(async () => runner) } satisfies CodeTaskRunnerProvider,
      authenticationSecrets,
    });
    const run = await coordinator.create(owner, createInput());
    expect(run.playwrightVerification).toEqual(playwrightVerification);
    await coordinator.freezeExecutionBrief(owner, run.id, [{
      id: "case-1",
      title: "accepted browser flow",
      priority: "P1",
      target: "web",
      preconditions: [],
      steps: [{ action: "open flow", expected: ["flow is visible"] }],
      testData: {},
      tags: [],
      evidenceRefs: [],
      unresolvedQuestions: [],
    }], {
      owner: "o",
      repository: "r",
      workspacePath: "target",
      baseSha,
      allowedPaths: ["e2e"],
      skillPaths: [],
      e2eSkillPath: ".agents/skills/e2e-testing/SKILL.md",
      e2eAuthentication: {
        strategy: "repository-playwright-setup",
        setupPath: "e2e/auth.setup.ts",
        setupProject: "setup",
        requiredEnvironment: ["E2E_LOGIN_EMAIL", "E2E_LOGIN_PASSWORD"],
      },
      specGlobs: ["e2e/**/*.spec.ts"],
      artifactGlobs: [],
      verification: playwrightVerification,
    });
    const frozen = await repository.get(owner, run.id);
    await repository.update(owner, run.id, frozen!.revision, { baseSha });

    await coordinator.execute(owner, run.id);

    expect(submitted.map(spec => spec.executionProfileId)).toEqual(["web-e2e-author", "web-e2e-verifier"]);
    expect(submitted.map(spec => spec.fixedChecks)).toEqual([
      [{ id: "repo-install" }],
      [{ id: "repo-install" }, { id: "playwright" }],
    ]);
    expect(submitted[0]?.playwrightVerification).toEqual(frozen?.executionBrief?.repository.verification);
    expect(frozen?.executionBrief?.repository.testEnvironment).toEqual({ id: "qasey-test", baseUrl: "https://e2e.example.test" });
    expect(submitted[1]?.playwrightVerification).toEqual(frozen?.executionBrief?.repository.verification);
    expect(submitted.map(spec => spec.playwrightVerification)).toEqual([
      playwrightVerification,
      playwrightVerification,
    ]);
    expect(submitted[1]?.attemptId).not.toBe(submitted[0]?.attemptId);
    expect(draftPr.publishChanges).toHaveBeenCalledTimes(1);
    expect(authenticationSecrets.resolve).toHaveBeenCalledWith({
      owner,
      names: ["E2E_LOGIN_EMAIL", "E2E_LOGIN_PASSWORD"],
    });
    expect(submittedSecrets).toEqual([
      undefined,
      {
        QASEY_E2E_BASE_URL: "https://e2e.example.test",
        E2E_LOGIN_EMAIL: "operator@example.test",
        E2E_LOGIN_PASSWORD: "redacted-password",
      },
    ]);
    expect(await repository.get(owner, run.id)).toMatchObject({
      status: "awaiting_qa",
      pullRequestUrl: "https://github.com/o/r/pull/1",
    });
    await coordinator.verdict(owner, run.id, { verdict: "approve", reviewerId: "qa-1" });
    expect(draftPr.markReady).toHaveBeenCalledTimes(1);
    expect(await repository.get(owner, run.id)).toMatchObject({ status: "succeeded" });
  });

  it("replaces the persisted patch reference after a QA repair", async () => {
    const owner = { applicationId: "qasey", tenantId: "tenant-1" };
    const repository = new InMemoryRunRepository();
    const submitted: CodeTaskSpec[] = [];
    const initialPatch = "diff --git a/e2e/initial.spec.ts b/e2e/initial.spec.ts";
    const repairedPatch = "diff --git a/e2e/repaired.spec.ts b/e2e/repaired.spec.ts";
    const runner = fakeRunner(submitted, [], [initialPatch, repairedPatch]);
    const effectSteps: string[] = [];
    const coordinator = new E2ECoordinator(repository, artifacts(), broker(), {
      maxRepairs: 2,
      reviewBaseUrl: "https://qasey.test",
      codeTasks: { forScope: vi.fn(async () => runner) },
      authenticationSecrets: {
        resolve: vi.fn(async () => ({
          E2E_LOGIN_EMAIL: "operator@example.test",
          E2E_LOGIN_PASSWORD: "redacted-password",
        })),
      },
      effects: {
        execute: vi.fn(async input => {
          effectSteps.push(input.stepId);
          return (await input.operation("test-idempotency-key")).result;
        }),
      },
    });
    const run = await coordinator.create(owner, createInput());
    await coordinator.freezeExecutionBrief(owner, run.id, [{
      id: "e7be1d8a-c291-4ac5-a966-ab26d9780ca8",
      title: "accepted browser flow",
      priority: "P1",
      target: "web",
      preconditions: [],
      steps: [{ action: "open flow", expected: ["flow is visible"] }],
      testData: {},
      tags: [],
      evidenceRefs: [],
      unresolvedQuestions: [],
    }], {
      owner: "o",
      repository: "r",
      workspacePath: "target",
      baseSha,
      allowedPaths: ["e2e"],
      skillPaths: [],
      e2eSkillPath: ".agents/skills/e2e-testing/SKILL.md",
      e2eAuthentication: {
        strategy: "repository-playwright-setup",
        setupPath: "e2e/auth.setup.ts",
        setupProject: "setup",
        requiredEnvironment: ["E2E_LOGIN_EMAIL", "E2E_LOGIN_PASSWORD"],
      },
      specGlobs: ["e2e/**/*.spec.ts"],
      artifactGlobs: [],
      verification: playwrightVerification,
    });
    const frozen = await repository.get(owner, run.id);
    await repository.update(owner, run.id, frozen!.revision, { baseSha });
    await coordinator.execute(owner, run.id);
    await coordinator.verdict(owner, run.id, {
      verdict: "request_changes",
      reviewerId: "qa-1",
      feedback: "Repair the test setup",
      caseVersionId: "e7be1d8a-c291-4ac5-a966-ab26d9780ca8",
    });

    await coordinator.authorAndPersistPatch(owner, run.id, "Repair the test setup");
    await coordinator.cleanVerifyAndPublish(owner, run.id, true);

    const latest = await repository.get(owner, run.id);
    const patchRefs = latest!.artifacts.filter(item => item.id === `${run.id}:patch`);
    expect(patchRefs).toHaveLength(1);
    expect(patchRefs[0]?.sha256).toBe(createHash("sha256").update(repairedPatch).digest("hex"));
    expect(submitted.at(-1)?.inputPatchRef).toEqual(patchRefs[0]);
    expect(effectSteps).toEqual([
      `publish-draft-pull-request:${createHash("sha256").update(initialPatch).digest("hex")}`,
      `publish-draft-pull-request:${createHash("sha256").update(repairedPatch).digest("hex")}`,
    ]);
    expect(latest).toMatchObject({ status: "awaiting_qa" });
  });
});

function createInput() {
  return {
    sourceSessionId: "s",
    changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff",
    platform: "web" as const,
    framework: "playwright" as const,
    handoff: handoff(),
    repository: {
      owner: "o",
      repository: "r",
      cloneUrl: "https://example.test/r.git",
      baseRef: "main",
      allowedPaths: ["e2e"],
      skillsPaths: [],
      e2eSkillPath: ".agents/skills/e2e-testing/SKILL.md",
      e2eAuthentication: {
        strategy: "repository-playwright-setup" as const,
        setupPath: "e2e/auth.setup.ts",
        setupProject: "setup",
        requiredEnvironment: ["E2E_LOGIN_EMAIL", "E2E_LOGIN_PASSWORD"],
      },
    },
    testEnvironment: { id: "qasey-test", baseUrl: "https://e2e.example.test" },
    playwrightVerification,
  };
}

const playwrightVerification = {
  strategy: "changed-project-playwright" as const,
  projects: [{
    id: "e2e",
    root: "e2e",
    testRoot: "e2e",
    config: "e2e/playwright.config.ts",
    playwrightProject: "chromium",
  }],
};

function artifacts(): ArtifactStore {
  let patch = "";
  return {
    savePatch: vi.fn(async (_owner, runId, content) => {
      patch = content;
      return {
        ...ref(`${runId}:patch`, "patch", "changes.patch", "file:///changes.patch"),
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    }),
    loadPatch: vi.fn(async () => patch),
    saveContext: vi.fn(async (_owner, runId) => ref(`${runId}:execution-brief`, "report", "execution-brief.json", "file:///brief.json")),
    saveTaskContext: vi.fn(async (_owner, runId, taskId) => ref(`${runId}:${taskId}`, "report", "context.json", "file:///context.json")),
    persistContent: vi.fn(async (_owner, _runId, _phase, artifact) => artifact),
    persist: vi.fn(async (_owner, _runId, _phase, refs) => refs),
  };
}

function broker(): DraftPrBroker {
  return {
    publishChanges: vi.fn(async () => "https://github.com/o/r/pull/1"),
    markReady: vi.fn(async () => undefined),
  };
}

function fakeRunner(
  submitted: CodeTaskSpec[],
  submittedSecrets: Array<Readonly<Record<string, string>> | undefined> = [],
  patchContents = ["diff --git a/e2e/a.spec.ts b/e2e/a.spec.ts"],
): CodeTaskRunner {
  const specs = new Map<string, CodeTaskSpec>();
  const patchRef = ref("sandbox-patch", "patch", "changes.patch", "sandbox://changes.patch");
  const contentRef = ref("sandbox-content", "report", "a.spec.ts", "sandbox://a.spec.ts");
  let patchReadIndex = 0;
  return {
    submit: vi.fn(async (spec, secrets) => {
      submitted.push(spec);
      submittedSecrets.push(secrets?.environment);
      specs.set(spec.taskId, spec);
      return { taskId: spec.taskId, attemptId: spec.attemptId, status: "succeeded" as const };
    }),
    events: vi.fn(async () => ({ events: [] })),
    get: vi.fn(async taskId => {
      const spec = specs.get(taskId)!;
      const verifier = spec.executionProfileId === "web-e2e-verifier";
      const result: CodeTaskResult = {
        status: "succeeded",
        summary: verifier ? "verified" : "authored",
        changedPaths: ["e2e/a.spec.ts"],
        changes: verifier ? [{
          path: "e2e/a.spec.ts",
          status: "added",
          mode: "100644",
          contentRef,
        }] : [],
        ...(verifier ? {} : { patchRef }),
        checks: [],
        artifacts: [],
        provenance: {
          imageDigest: "local-development",
          profileHash: sha,
          agentBackend: "native-mastra",
          mastraVersion: "1.59.0",
          model: "gpt-5.6-sol",
        },
      };
      const now = new Date().toISOString();
      return {
        taskId,
        attemptId: spec.attemptId,
        status: "succeeded" as const,
        createdAt: now,
        updatedAt: now,
        result,
      };
    }),
    cancel: vi.fn(async () => undefined),
    artifact: vi.fn(async artifact => Buffer.from(artifact.id === patchRef.id
      ? patchContents[Math.min(patchReadIndex++, patchContents.length - 1)]!
      : "test('flow', async () => {});")),
  };
}

function ref(id: string, kind: ArtifactRef["kind"], name: string, uri: string): ArtifactRef {
  return { id, kind, name, uri, sha256: sha };
}

function handoff() {
  return {
    goal: "Cover the accepted browser flow",
    requirementSummary: "Author an E2E test from the accepted case",
    inScope: [], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [],
    criticalFlows: [], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [],
    blockingQuestions: [], evidenceRefs: [],
  };
}
