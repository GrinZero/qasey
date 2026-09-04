import { createHash, randomUUID } from "node:crypto";
import { CreateE2ERunSchema } from "../../contracts/src/index.ts";
import type { CodeTaskChange, CodeTaskSpec, CreateE2ERun, E2ERun, E2ERepositoryExecution, OwnerScope, QaVerdict, TestCaseSpec } from "../../contracts/src/index.ts";
import { assertRunTransition, createE2EAmendment, freezeE2EContext, freezeE2EExecutionBrief, RunRevisionConflictError, type E2EContextSource, type RunRepository } from "../../domain/src/index.ts";
import { submitAndWaitForCodeTask, type CodeTaskRunner, type CodeTaskRunnerProvider } from "../../code-task/src/index.ts";
import type { ArtifactStore } from "./artifacts.ts";

export interface SideEffectRunner {
  execute<T>(input: {
    owner: OwnerScope;
    runId: string;
    stepId: string;
    businessKey: string;
    request: unknown;
    operation: (idempotencyKey: string) => Promise<{ result: T; externalRef?: string }>;
  }): Promise<T>;
}

export interface DraftPrBroker {
  publishChanges(run: E2ERun, changes: PublishedChange[], reviewUrl: string): Promise<string | undefined>;
  markReady(run: E2ERun): Promise<void>;
}

export interface PublishedChange {
  path: string;
  deleted: boolean;
  mode?: "100644" | "100755" | "120000";
  content?: Buffer;
}

export interface E2EFixtureLease {
  id: string;
  baseUrl: string;
  sourceSha: string;
  sessionToken: string;
}

export interface E2EFixtureLeaseProvider {
  acquire(input: { owner: OwnerScope; runId: string; expectedSourceSha: string; baseUrl: string }): Promise<E2EFixtureLease>;
  release(lease: E2EFixtureLease): Promise<void>;
}

export interface E2EAuthenticationSecretProvider {
  resolve(input: { owner: OwnerScope; names: readonly string[] }): Promise<Readonly<Record<string, string>>>;
}

export class NoopDraftPrBroker implements DraftPrBroker {
  async publishChanges(): Promise<undefined> { return undefined; }
  async markReady(): Promise<void> {}
}

export class E2ECoordinator {
  constructor(
    private readonly repository: RunRepository,
    private readonly artifacts: ArtifactStore,
    private readonly prBroker: DraftPrBroker,
    private readonly options: { maxRepairs: number; reviewBaseUrl: string; codeTasks?: CodeTaskRunnerProvider; effects?: SideEffectRunner; authenticationSecrets?: E2EAuthenticationSecretProvider },
  ) {}

  assertExecutionAvailable(): void {
    if (!this.options.codeTasks) {
      throw new Error("E2E execution unavailable: CodeTask Runner is not configured");
    }
  }

  async create(owner: OwnerScope, input: CreateE2ERun, sourceInput?: E2EContextSource): Promise<E2ERun> {
    this.assertExecutionAvailable();
    const trustedInput = CreateE2ERunSchema.parse(input);
    if (trustedInput.platform !== "web" || trustedInput.framework !== "playwright") {
      throw new Error("CodeTask-backed E2E currently supports Web Playwright only");
    }
    const now = new Date().toISOString();
    const requestId = trustedInput.requestId ?? randomUUID();
    const source = sourceInput ?? {
      sessionId: trustedInput.sourceSessionId,
      threadId: trustedInput.sourceSessionId,
      taskRunId: requestId,
      requestId,
      resourceId: "api",
    };
    const contextSnapshot = freezeE2EContext(trustedInput.handoff, source);
    const run: E2ERun = {
      ...owner,
      id: randomUUID(), requestId, sourceSessionId: source.sessionId,
      changeSetId: trustedInput.changeSetId, contextSnapshot, caseSnapshot: [], amendments: [], codeTaskIds: [],
      repository: trustedInput.repository, platform: trustedInput.platform,
      testEnvironment: trustedInput.testEnvironment,
      playwrightVerification: trustedInput.playwrightVerification,
      framework: trustedInput.framework, status: "queued", revision: 1, createdAt: now, updatedAt: now, artifacts: [],
    };
    await this.repository.create(owner, run);
    await this.repository.addEvent(owner, run.id, "run.created", "E2E run queued");
    return run;
  }

  async freezeExecutionBrief(
    owner: OwnerScope,
    runId: string,
    cases: TestCaseSpec[],
    repositoryExecution: E2ERepositoryExecution,
    traceId?: string,
  ): Promise<E2ERun> {
    const run = await this.requireRun(owner, runId);
    if (run.executionBrief) {
      if (run.executionBrief.briefHash !== run.briefHash) throw new Error("Persisted E2E brief hash is inconsistent");
      return run;
    }
    if (!run.playwrightVerification) {
      throw new Error("This legacy E2E run has no frozen Playwright verification mapping; create a new run");
    }
    if (!run.testEnvironment) {
      throw new Error("This legacy E2E run has no frozen test environment; create a new run");
    }
    const trustedRepositoryExecution: E2ERepositoryExecution = {
      ...repositoryExecution,
      testEnvironment: run.testEnvironment,
      verification: run.playwrightVerification,
    };
    const executionBrief = freezeE2EExecutionBrief({ context: run.contextSnapshot, cases, repository: trustedRepositoryExecution });
    const contextArtifact = await this.artifacts.saveContext(owner, run.id, executionBrief);
    const artifacts = [...run.artifacts, contextArtifact];
    const updated = await this.repository.update(owner, run.id, run.revision, {
      caseSnapshot: cases,
      executionBrief,
      briefHash: executionBrief.briefHash,
      repositoryExecution: trustedRepositoryExecution,
      artifacts,
      ...(traceId ? { traceId } : {}),
    });
    await this.repository.addEvent(owner, run.id, "run.context_frozen", "E2E execution brief frozen", { briefHash: executionBrief.briefHash, caseCount: cases.length });
    return updated;
  }

  async execute(owner: OwnerScope, runId: string, qaFeedback?: string): Promise<void> {
    try {
      await this.authorAndPersistPatch(owner, runId, qaFeedback);
      await this.cleanVerifyAndPublish(owner, runId);
    } catch (error) {
      await this.fail(owner, runId, error);
    }
  }

  async authorAndPersistPatch(owner: OwnerScope, runId: string, qaFeedback?: string): Promise<void> {
    this.assertExecutionAvailable();
    return this.authorWithCodeTasks(owner, runId, qaFeedback);
  }

  async cleanVerifyAndPublish(owner: OwnerScope, runId: string, requirePassing = false): Promise<void> {
    this.assertExecutionAvailable();
    return this.verifyWithCodeTask(owner, runId, requirePassing);
  }

  private async authorWithCodeTasks(owner: OwnerScope, runId: string, qaFeedback?: string): Promise<void> {
    let run = await this.requireRun(owner, runId);
    if (!run.executionBrief || !run.briefHash || !run.baseSha) throw new Error("E2E execution brief and pinned base SHA must be frozen before authoring");
    const isQaRepair = run.status === "repairing";
    run = await this.transition(owner, run, "preparing_workspace", "Preparing pooled Sandbox CodeTask workspace");
    const branch = run.branch ?? `qasey/${run.id}`;
    run = await this.repository.update(owner, run.id, run.revision, { branch, baseSha: run.baseSha });
    run = await this.transition(owner, run, "authoring", isQaRepair ? "Applying QA feedback with the Sandbox Mastra code agent" : "Delegating E2E authoring to the Sandbox Mastra code agent");
    const runner = await this.options.codeTasks!.forScope({ ...owner, sessionId: run.sourceSessionId });
    let inputPatchRef = isQaRepair ? run.artifacts.find(item => item.kind === "patch" && item.id === `${run.id}:patch`) : undefined;
    let priorFailure = "";
    for (let attempt = 0; attempt <= this.options.maxRepairs; attempt += 1) {
      const taskId = `${run.id}:author:${attempt}`;
      const instruction = qaFeedback
        ? `QA amendment:\n${qaFeedback}\nUpdate only the E2E implementation and keep assertions meaningful.`
        : priorFailure
          ? `Repair only the E2E implementation. Do not weaken assertions. Previous fixed-check result:\n${priorFailure}`
          : "Implement the frozen accepted QA cases. Preserve product behavior and run the repository checks.";
      const contextContent = JSON.stringify({ brief: run.executionBrief, amendments: run.amendments, instruction });
      const contextRef = await this.artifacts.saveTaskContext(owner, run.id, taskId, contextContent);
      run = await this.appendArtifacts(owner, run, [contextRef]);
      run = await this.transition(owner, run, "author_running", `Running Sandbox CodeTask author attempt ${attempt + 1}`);
      const spec = this.codeTaskSpec(run, taskId, attempt, contextRef, contextRef.sha256!, {
        profile: attempt === 0 && !isQaRepair ? "web-e2e-author" : "web-e2e-repair",
        kind: attempt === 0 && !isQaRepair ? "author" : "repair",
        ...(inputPatchRef ? { inputPatchRef } : {}),
      });
      run = await this.repository.update(owner, run.id, run.revision, { codeTaskIds: [...run.codeTaskIds, taskId] });
      await this.repository.addEvent(owner, run.id, "code_task.submitted", "Sandbox CodeTask submitted", codeTaskMetadata(spec));
      const startedAt = Date.now();
      const executed = await submitAndWaitForCodeTask(runner, spec, {
        deadlineMs: spec.deadlineMs + 30_000,
        lostRetries: 1,
        onHeartbeat: throttledHeartbeat(() => this.repository.heartbeat(owner, run.id)),
      });
      const result = executed.result;
      await this.repository.addEvent(owner, run.id, "code_task.completed", `Sandbox CodeTask ${result.status}`, {
        ...codeTaskMetadata(executed.spec), status: result.status, durationMs: Date.now() - startedAt, provenance: result.provenance,
      });
      run = await this.persistCodeTaskEvidence(owner, run, "author", runner, result.artifacts.filter(item => item.kind === "log"));
      if (result.patchRef) {
        const patch = (await runner.artifact(result.patchRef)).toString("utf8");
        inputPatchRef = await this.artifacts.savePatch(owner, run.id, patch);
        run = await this.upsertArtifact(owner, run, inputPatchRef);
      }
      if (result.status === "succeeded") {
        if (!inputPatchRef) throw new Error("Sandbox author succeeded without a patch");
        return;
      }
      priorFailure = result.summary.slice(-8_000);
      if (isAssertionFailureSummary(priorFailure) || attempt === this.options.maxRepairs || !inputPatchRef) {
        throw new Error(`Author CodeTask failed without an eligible repair: ${priorFailure.slice(-1_500)}`);
      }
      run = await this.transition(owner, run, "repairing", `Sandbox author check failed; starting bounded repair ${attempt + 1}`);
    }
  }

  private async verifyWithCodeTask(owner: OwnerScope, runId: string, requirePassing: boolean): Promise<void> {
    let run = await this.requireRun(owner, runId);
    if (!run.executionBrief || !run.briefHash || !run.baseSha) throw new Error("E2E execution brief and pinned base SHA must be frozen before verification");
    if (!run.testEnvironment) throw new Error("This legacy E2E run has no frozen test environment; create a new run");
    const testEnvironment = run.testEnvironment;
    const patchRef = run.artifacts.find(item => item.kind === "patch" && item.id === `${run.id}:patch`);
    if (!patchRef) throw new Error("Clean verifier requires the persisted author patch");
    const runner = await this.options.codeTasks!.forScope({ ...owner, sessionId: run.sourceSessionId });
    const verifierAttempt = run.codeTaskIds.filter(id => id.startsWith(`${run.id}:verifier:`)).length;
    const taskId = `${run.id}:verifier:${verifierAttempt}`;
    const contextContent = JSON.stringify({ brief: run.executionBrief, purpose: "Apply the immutable patch and run fixed clean verification only." });
    const contextRef = await this.artifacts.saveTaskContext(owner, run.id, taskId, contextContent);
    run = await this.appendArtifacts(owner, run, [contextRef]);
    run = await this.transition(owner, run, "clean_verifying", "Running immutable patch in a fresh independent Sandbox verifier checkout");
    const spec = this.codeTaskSpec(run, taskId, 0, contextRef, contextRef.sha256!, {
      profile: "web-e2e-verifier",
      kind: "author",
      inputPatchRef: patchRef,
    });
    const authentication = run.executionBrief?.repository.e2eAuthentication;
    if (!authentication) throw new Error("Clean verifier requires the frozen repository authentication contract");
    if (!this.options.authenticationSecrets) throw new Error("Clean verifier authentication secrets are not configured");
    const authenticationEnvironment = await this.options.authenticationSecrets.resolve({
      owner,
      names: authentication.requiredEnvironment,
    });
    const unexpectedAuthenticationEnvironment = Object.keys(authenticationEnvironment)
      .filter(name => !authentication.requiredEnvironment.includes(name));
    if (unexpectedAuthenticationEnvironment.length > 0) {
      throw new Error(`Clean verifier authentication provider returned undeclared environment variables: ${unexpectedAuthenticationEnvironment.join(", ")}`);
    }
    for (const name of authentication.requiredEnvironment) {
      if (!authenticationEnvironment[name]?.trim()) throw new Error(`Clean verifier authentication environment is missing ${name}`);
    }
    run = await this.repository.update(owner, run.id, run.revision, { codeTaskIds: [...run.codeTaskIds, taskId] });
    await this.repository.addEvent(owner, run.id, "code_task.submitted", "Sandbox verifier CodeTask submitted", codeTaskMetadata(spec));
    const startedAt = Date.now();
    const executed = await submitAndWaitForCodeTask(runner, spec, {
      deadlineMs: spec.deadlineMs + 30_000,
      lostRetries: 1,
      onHeartbeat: throttledHeartbeat(() => this.repository.heartbeat(owner, run.id)),
      secrets: { environment: {
        ...authenticationEnvironment,
        QASEY_E2E_BASE_URL: testEnvironment.baseUrl,
      } },
    });
    const result = executed.result;
    await this.repository.addEvent(owner, run.id, "code_task.completed", `Sandbox verifier CodeTask ${result.status}`, {
      ...codeTaskMetadata(executed.spec), status: result.status, durationMs: Date.now() - startedAt, provenance: result.provenance,
    });
    run = await this.persistCodeTaskEvidence(owner, run, "verifier", runner, result.artifacts);
    const reviewableTestFailure = result.status === "failed"
      && result.checks.some(check => check.id === "playwright" && !check.passed)
      && result.checks.every(check => check.id === "playwright" || check.passed);
    if (result.status !== "succeeded" && (!reviewableTestFailure || requirePassing)) {
      throw new Error(`Clean verifier CodeTask failed: ${result.summary.slice(-1_500)}`);
    }
    const changes = await this.materializePublishedChanges(runner, result.changes);
    const reviewUrl = `${this.options.reviewBaseUrl.replace(/\/$/, "")}/runs/${run.id}`;
    const publication = this.options.effects
      ? await this.options.effects.execute({
          owner,
          runId: run.id,
          stepId: "publish-draft-pull-request",
          businessKey: run.branch ?? run.id,
          request: {
            baseSha: run.baseSha,
            branch: run.branch,
            changes: changes.map(change => ({
              path: change.path,
              deleted: change.deleted,
              mode: change.mode,
              ...(change.content ? { sha256: createHash("sha256").update(change.content).digest("hex") } : {}),
            })),
          },
          operation: async () => {
            const pullRequestUrl = await this.prBroker.publishChanges(run, changes, reviewUrl);
            return {
              result: { ...(pullRequestUrl ? { pullRequestUrl } : {}) },
              ...(pullRequestUrl ? { externalRef: pullRequestUrl } : {}),
            };
          },
        })
      : { pullRequestUrl: await this.prBroker.publishChanges(run, changes, reviewUrl) };
    const pullRequestUrl = publication.pullRequestUrl;
    if (pullRequestUrl) run = await this.repository.update(owner, run.id, run.revision, { pullRequestUrl });
    else await this.repository.addEvent(owner, run.id, "pr.skipped", "Verifier passed; remote Draft PR broker is disabled");
    await this.transition(owner, run, "awaiting_qa", reviewableTestFailure
      ? "Clean Sandbox verifier completed with Case failures; awaiting QA classification"
      : "Clean Sandbox verifier passed; awaiting QA review");
  }

  private codeTaskSpec(
    run: E2ERun,
    taskId: string,
    attempt: number,
    contextRef: E2ERun["artifacts"][number],
    contextHash: string,
    options: { profile: CodeTaskSpec["executionProfileId"]; kind: CodeTaskSpec["kind"]; inputPatchRef?: E2ERun["artifacts"][number] },
  ): CodeTaskSpec {
    const playwrightVerification = run.executionBrief?.repository.verification;
    if (!playwrightVerification) {
      throw new Error("CodeTask execution requires the frozen Playwright verification mapping; create a new run");
    }
    const e2eSkillPath = run.executionBrief?.repository.e2eSkillPath;
    if (["web-e2e-author", "web-e2e-repair"].includes(options.profile) && !e2eSkillPath) {
      throw new Error("CodeTask authoring requires the frozen repository-local project Skill; create a new run");
    }
    return {
      taskId,
      attemptId: `${attempt}-${randomUUID()}`,
      kind: options.kind,
      scope: { applicationId: run.applicationId, tenantId: run.tenantId, sessionId: run.sourceSessionId },
      contextRef,
      contextHash,
      repositories: [{
        owner: run.repository.owner,
        repository: run.repository.repository,
        destination: "target",
        mode: "write",
        baseRef: run.repository.baseRef,
        baseSha: run.baseSha!,
      }],
      baseSha: run.baseSha!,
      executionProfileId: options.profile,
      allowedPaths: run.repository.allowedPaths,
      fixedChecks: options.profile === "web-e2e-verifier" ? [{ id: "repo-install" }, { id: "playwright" }] : [{ id: "repo-install" }],
      ...(e2eSkillPath ? { e2eSkillPath } : {}),
      e2eRequiredEnvironment: run.executionBrief?.repository.e2eAuthentication?.requiredEnvironment ?? [],
      playwrightVerification,
      deadlineMs: 20 * 60_000,
      traceContext: { ...(run.traceId ? { traceId: run.traceId } : {}) },
      ...(options.inputPatchRef ? { inputPatchRef: options.inputPatchRef } : {}),
    };
  }

  private async persistCodeTaskEvidence(
    owner: OwnerScope,
    run: E2ERun,
    phase: "author" | "verifier",
    runner: CodeTaskRunner,
    refs: E2ERun["artifacts"],
  ): Promise<E2ERun> {
    const persisted = [];
    for (const ref of refs) persisted.push(await this.artifacts.persistContent(owner, run.id, phase, ref, await runner.artifact(ref)));
    return persisted.length ? this.appendArtifacts(owner, run, persisted) : run;
  }

  private async materializePublishedChanges(runner: CodeTaskRunner, changes: CodeTaskChange[]): Promise<PublishedChange[]> {
    const materialized: PublishedChange[] = [];
    for (const change of changes) {
      if (change.status === "deleted") { materialized.push({ path: change.path, deleted: true }); continue; }
      if (!change.contentRef || !change.mode) throw new Error(`Verifier change ${change.path} has no content artifact`);
      materialized.push({ path: change.path, deleted: false, mode: change.mode, content: await runner.artifact(change.contentRef) });
    }
    return materialized;
  }

  async fail(owner: OwnerScope, runId: string, error: unknown): Promise<void> {
    if (error instanceof RunRevisionConflictError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const current = await this.requireRun(owner, runId);
    if (!["failed", "cancelled", "succeeded"].includes(current.status)) {
      await this.repository.update(owner, runId, current.revision, { status: "failed", error: message });
      await this.repository.addEvent(owner, runId, "run.failed", message);
    }
  }

  async verdict(owner: OwnerScope, runId: string, verdict: QaVerdict): Promise<E2ERun> {
    const run = await this.requireRun(owner, runId);
    if (run.status !== "awaiting_qa") throw new Error("QA verdict requires awaiting_qa status");
    if (verdict.verdict === "approve") {
      if (run.pullRequestUrl) await this.prBroker.markReady(run);
      return this.transition(owner, run, "succeeded", `Approved by ${verdict.reviewerId}; Draft PR marked ready`);
    }
    if (verdict.caseVersionId && run.amendments.filter(item => item.caseVersionId === verdict.caseVersionId).length >= 2) {
      throw new Error(`Case Version ${verdict.caseVersionId} reached the two-revision limit`);
    }
    let repaired = await this.transition(owner, run, "repairing", `Changes requested by ${verdict.reviewerId}`);
    if (verdict.feedback) {
      repaired = await this.repository.update(owner, runId, repaired.revision, { amendments: [...repaired.amendments, createE2EAmendment(verdict.reviewerId, verdict.feedback, new Date(), verdict.caseVersionId)] });
    }
    await this.repository.addEvent(owner, runId, "qa.feedback", verdict.feedback ?? "Changes requested");
    return repaired;
  }

  async rerun(owner: OwnerScope, runId: string): Promise<E2ERun> {
    this.assertExecutionAvailable();
    const previous = await this.requireRun(owner, runId);
    const { pullRequestUrl: _pullRequestUrl, error: _error, ...reusable } = previous;
    const now = new Date().toISOString();
    const rerun: E2ERun = {
      ...reusable,
      id: randomUUID(),
      requestId: randomUUID(),
      status: "queued",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      artifacts: previous.executionBrief ? previous.artifacts.filter(item => item.id.endsWith(":execution-brief")) : [],
      amendments: [],
      codeTaskIds: [],
      branch: `qasey/${randomUUID()}`,
    };
    await this.repository.create(owner, rerun);
    await this.repository.addEvent(owner, rerun.id, "run.created", `E2E rerun queued from ${previous.id}`, { sourceRunId: previous.id, briefHash: previous.briefHash });
    return rerun;
  }

  async cancel(owner: OwnerScope, runId: string): Promise<E2ERun> {
    const run = await this.requireRun(owner, runId);
    if (this.options.codeTasks && run.codeTaskIds.length) {
      const runner = await this.options.codeTasks.forScope({ ...owner, sessionId: run.sourceSessionId });
      for (const taskId of run.codeTaskIds) {
        const state = await runner.get(taskId).catch(() => undefined);
        if (state && !["succeeded", "failed", "cancelled", "lost"].includes(state.status)) {
          await runner.cancel(taskId, `E2E run ${run.id} cancelled`).catch(() => undefined);
        }
      }
    }
    return this.transition(owner, run, "cancelled", "Run cancelled");
  }

  private async appendArtifacts(owner: OwnerScope, run: E2ERun, artifacts: E2ERun["artifacts"]): Promise<E2ERun> {
    return this.repository.update(owner, run.id, run.revision, { artifacts: [...run.artifacts, ...artifacts] });
  }

  private async upsertArtifact(owner: OwnerScope, run: E2ERun, artifact: E2ERun["artifacts"][number]): Promise<E2ERun> {
    return this.repository.update(owner, run.id, run.revision, {
      artifacts: [...run.artifacts.filter(item => item.id !== artifact.id), artifact],
    });
  }

  private async transition(owner: OwnerScope, run: E2ERun, status: E2ERun["status"], message: string): Promise<E2ERun> {
    assertRunTransition(run.status, status);
    const updated = await this.repository.update(owner, run.id, run.revision, { status, ...(status === "failed" ? { error: message } : {}) });
    await this.repository.addEvent(owner, run.id, `run.${status}`, message);
    return updated;
  }

  private async requireRun(owner: OwnerScope, id: string): Promise<E2ERun> {
    const run = await this.repository.get(owner, id);
    if (!run) throw new Error(`Run ${id} not found`);
    return run;
  }
}

function isAssertionFailureSummary(summary: string): boolean {
  return /assertion|expect\(|expected.+received|断言/i.test(summary);
}

function codeTaskMetadata(spec: CodeTaskSpec): Record<string, unknown> {
  return {
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    kind: spec.kind,
    executionProfileId: spec.executionProfileId,
    contextHash: spec.contextHash,
    baseSha: spec.baseSha,
    ...(spec.traceContext.traceId ? { traceId: spec.traceContext.traceId } : {}),
  };
}

function throttledHeartbeat(heartbeat: () => Promise<void>, intervalMs = 15_000): () => Promise<void> {
  let last = 0;
  return async () => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    await heartbeat();
  };
}
