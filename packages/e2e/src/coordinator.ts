import { randomUUID } from "node:crypto";
import type { CodeTaskChange, CodeTaskSpec, CreateE2ERun, E2ERun, E2ERepositoryExecution, OwnerScope, QaVerdict, TestCaseSpec } from "../../contracts/src/index.ts";
import { assertRunTransition, createE2EAmendment, freezeE2EContext, freezeE2EExecutionBrief, type E2EContextSource, type RunRepository } from "../../domain/src/index.ts";
import { submitAndWaitForCodeTask, type CodeTaskRunner, type CodeTaskRunnerProvider } from "../../code-task/src/index.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { CuaFallback } from "./cua.ts";
import type { CodingHarness } from "./harness.ts";
import type { E2ERunResult, E2ERunner } from "./runner.ts";
import type { WorkspaceManager, WorkspaceRef } from "./workspace.ts";

export interface DraftPrBroker {
  publish(run: E2ERun, workspace: WorkspaceRef, reviewUrl: string): Promise<string | undefined>;
  publishChanges?(run: E2ERun, changes: PublishedChange[], reviewUrl: string): Promise<string | undefined>;
  markReady(run: E2ERun): Promise<void>;
}

export interface PublishedChange {
  path: string;
  deleted: boolean;
  mode?: "100644" | "100755" | "120000";
  content?: Buffer;
}

export class NoopDraftPrBroker implements DraftPrBroker {
  async publish(): Promise<undefined> { return undefined; }
  async publishChanges(): Promise<undefined> { return undefined; }
  async markReady(): Promise<void> {}
}

export class E2ECoordinator {
  constructor(
    private readonly repository: RunRepository,
    private readonly workspaces: WorkspaceManager,
    private readonly harness: CodingHarness,
    private readonly runners: Record<"playwright" | "maestro", E2ERunner>,
    private readonly artifacts: ArtifactStore,
    private readonly prBroker: DraftPrBroker,
    // Kept for constructor compatibility; orchestration is owned by the Mastra workflow.
    private readonly executionEnabled: boolean,
    private readonly options: { maxRepairs: number; reviewBaseUrl: string; cua?: CuaFallback; codeTasks?: CodeTaskRunnerProvider },
  ) {}

  async create(owner: OwnerScope, input: CreateE2ERun, sourceInput?: E2EContextSource): Promise<E2ERun> {
    if ((input.platform === "web") !== (input.framework === "playwright")) throw new Error("Web requires Playwright; app requires Maestro");
    const now = new Date().toISOString();
    const requestId = input.requestId ?? randomUUID();
    const source = sourceInput ?? {
      sessionId: input.sourceSessionId,
      threadId: input.sourceSessionId,
      taskRunId: requestId,
      requestId,
      resourceId: "api",
    };
    const contextSnapshot = freezeE2EContext(input.handoff, source);
    const run: E2ERun = {
      ...owner,
      id: randomUUID(), requestId, sourceSessionId: source.sessionId,
      sourceCaseIds: input.sourceCaseIds, contextSnapshot, caseSnapshot: [], amendments: [], codeTaskIds: [],
      repository: input.repository, platform: input.platform,
      framework: input.framework, status: "queued", createdAt: now, updatedAt: now, artifacts: [],
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
    const executionBrief = freezeE2EExecutionBrief({ context: run.contextSnapshot, cases, repository: repositoryExecution });
    const contextArtifact = await this.artifacts.saveContext(owner, run.id, executionBrief);
    const artifacts = [...run.artifacts, contextArtifact];
    const updated = await this.repository.update(owner, run.id, {
      caseSnapshot: cases,
      executionBrief,
      briefHash: executionBrief.briefHash,
      repositoryExecution,
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
    if (this.options.codeTasks) return this.authorWithCodeTasks(owner, runId, qaFeedback);
    let run = await this.requireRun(owner, runId);
    let author: WorkspaceRef | undefined;
    try {
      const isQaRepair = run.status === "repairing";
      run = await this.transition(owner, run, "preparing_workspace", "Preparing isolated author workspace");
      author = await this.workspaces.create(run.repository, `${run.id}-author`, {
        namespace: `${owner.applicationId}-${owner.tenantId}`,
        purpose: "author",
        branch: run.branch ?? `qasey/${run.id}`,
        ...(run.baseSha ? { baseSha: run.baseSha } : {}),
      });
      if (isQaRepair) await this.workspaces.applyPatch(author, await this.artifacts.loadPatch(owner, run.id));
      await this.installDependencies(author);
      run = await this.repository.update(owner, run.id, { branch: author.branch, baseSha: author.baseSha });
      run = await this.transition(owner, run, "authoring", isQaRepair ? "Applying QA feedback in ACP coding harness" : "Delegating E2E authoring to ACP coding harness");
      await this.harness.author({
        runId: run.id, framework: run.framework, sourceCaseIds: run.sourceCaseIds,
        instruction: qaFeedback
          ? `QA 要求进行以下修改：\n${qaFeedback}\n只更新 E2E 实现，然后运行仓库检查。`
          : "实现已验收的 QA 用例，然后运行仓库检查。除非明确允许为测试提供支持，否则保留产品代码不变。",
      }, author);

      let authorResult: E2ERunResult | undefined;
      for (let repair = 0; repair <= this.options.maxRepairs; repair += 1) {
        await this.workspaces.assertAllowedChanges(author);
        run = await this.transition(owner, run, "author_running", `Running ${run.framework} in author workspace (attempt ${repair + 1})`);
        authorResult = await this.runners[run.framework].run(author, `${run.id}:author:${repair}`);
        run = await this.appendArtifacts(owner, run, await this.artifacts.persist(owner, run.id, "author", authorResult.artifacts));
        if (authorResult.passed) break;
        if (isAssertionFailure(authorResult) || repair === this.options.maxRepairs) {
          throw new Error(`Author run failed without an eligible repair: ${authorResult.summary.slice(-1500)}`);
        }
        run = await this.transition(owner, run, "repairing", `Author run failed; starting bounded repair ${repair + 1}`);
        let exploration = "";
        if (isLocatorFailure(authorResult) && repair === this.options.maxRepairs - 1 && this.options.cua) {
          const observed = await this.options.cua.observe(author, run.id, "观察失败的 UI 流程，并提出确定性的 Playwright/Maestro 步骤。不要判断通过或失败。");
          run = await this.appendArtifacts(owner, run, await this.artifacts.persist(owner, run.id, "author", observed.artifacts));
          exploration = `\nCua observation (advisory only):\n${observed.summary}`;
        }
        await this.harness.author({
          runId: run.id, framework: run.framework, sourceCaseIds: run.sourceCaseIds,
          instruction: `只修复测试实现。不要弱化断言。运行器输出：\n${authorResult.summary}${exploration}`,
        }, author);
      }
      if (!authorResult?.passed) throw new Error("Author run did not pass");
      await this.workspaces.assertAllowedChanges(author);
      const patch = await this.workspaces.collectPatch(author);
      run = await this.appendArtifacts(owner, run, [await this.artifacts.savePatch(owner, run.id, patch)]);
    } finally {
      if (author) await this.workspaces.destroy(author).catch(() => undefined);
    }
  }

  async cleanVerifyAndPublish(owner: OwnerScope, runId: string): Promise<void> {
    if (this.options.codeTasks) return this.verifyWithCodeTask(owner, runId);
    let run = await this.requireRun(owner, runId);
    let verifier: WorkspaceRef | undefined;
    try {
      const patch = await this.artifacts.loadPatch(owner, run.id);
      verifier = await this.workspaces.create(run.repository, `${run.id}-verifier`, {
        namespace: `${owner.applicationId}-${owner.tenantId}`,
        purpose: "verifier",
        ...(run.branch ? { branch: run.branch } : {}),
        ...(run.baseSha ? { baseSha: run.baseSha } : {}),
      });
      await this.workspaces.applyPatch(verifier, patch);
      await this.installDependencies(verifier);
      run = await this.transition(owner, run, "clean_verifying", "Running immutable patch in a fresh verifier workspace");
      const verifierResult = await this.runners[run.framework].run(verifier, `${run.id}:verifier`);
      run = await this.appendArtifacts(owner, run, await this.artifacts.persist(owner, run.id, "verifier", verifierResult.artifacts));
      if (!verifierResult.passed) throw new Error(`Clean verifier failed: ${verifierResult.summary.slice(-1500)}`);
      const reviewUrl = `${this.options.reviewBaseUrl.replace(/\/$/, "")}/runs/${run.id}`;
      const pullRequestUrl = await this.prBroker.publish(run, verifier, reviewUrl);
      if (pullRequestUrl) run = await this.repository.update(owner, run.id, { pullRequestUrl });
      else await this.repository.addEvent(owner, run.id, "pr.skipped", "Verifier passed; Draft PR broker is disabled");
      await this.transition(owner, run, "awaiting_qa", "Clean verifier passed; awaiting QA review");
    } finally {
      if (verifier) await this.workspaces.destroy(verifier).catch(() => undefined);
    }
  }

  private async authorWithCodeTasks(owner: OwnerScope, runId: string, qaFeedback?: string): Promise<void> {
    let run = await this.requireRun(owner, runId);
    if (!run.executionBrief || !run.briefHash || !run.baseSha) throw new Error("E2E execution brief and pinned base SHA must be frozen before authoring");
    const isQaRepair = run.status === "repairing";
    run = await this.transition(owner, run, "preparing_workspace", "Preparing pooled Sandbox CodeTask workspace");
    const branch = run.branch ?? `qasey/${run.id}`;
    run = await this.repository.update(owner, run.id, { branch, baseSha: run.baseSha });
    run = await this.transition(owner, run, "authoring", isQaRepair ? "Applying QA feedback in Sandbox ACP worker" : "Delegating E2E authoring to Sandbox ACP worker");
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
      run = await this.repository.update(owner, run.id, { codeTaskIds: [...run.codeTaskIds, taskId] });
      await this.repository.addEvent(owner, run.id, "code_task.submitted", "Sandbox CodeTask submitted", codeTaskMetadata(spec));
      const startedAt = Date.now();
      const executed = await submitAndWaitForCodeTask(runner, spec, { deadlineMs: spec.deadlineMs + 30_000, lostRetries: 1 });
      const result = executed.result;
      await this.repository.addEvent(owner, run.id, "code_task.completed", `Sandbox CodeTask ${result.status}`, {
        ...codeTaskMetadata(executed.spec), status: result.status, durationMs: Date.now() - startedAt, provenance: result.provenance,
      });
      run = await this.persistCodeTaskEvidence(owner, run, "author", runner, result.artifacts.filter(item => item.kind === "log"));
      if (result.patchRef) {
        const patch = (await runner.artifact(result.patchRef)).toString("utf8");
        inputPatchRef = await this.artifacts.savePatch(owner, run.id, patch);
      }
      if (result.status === "succeeded") {
        if (!inputPatchRef) throw new Error("Sandbox author succeeded without a patch");
        if (!run.artifacts.some(item => item.id === inputPatchRef!.id)) run = await this.appendArtifacts(owner, run, [inputPatchRef]);
        return;
      }
      priorFailure = result.summary.slice(-8_000);
      if (isAssertionFailureSummary(priorFailure) || attempt === this.options.maxRepairs || !inputPatchRef) {
        throw new Error(`Author CodeTask failed without an eligible repair: ${priorFailure.slice(-1_500)}`);
      }
      run = await this.transition(owner, run, "repairing", `Sandbox author check failed; starting bounded repair ${attempt + 1}`);
    }
  }

  private async verifyWithCodeTask(owner: OwnerScope, runId: string): Promise<void> {
    let run = await this.requireRun(owner, runId);
    if (!run.executionBrief || !run.briefHash || !run.baseSha) throw new Error("E2E execution brief and pinned base SHA must be frozen before verification");
    const patchRef = run.artifacts.find(item => item.kind === "patch" && item.id === `${run.id}:patch`);
    if (!patchRef) throw new Error("Clean verifier requires the persisted author patch");
    const runner = await this.options.codeTasks!.forScope({ ...owner, sessionId: run.sourceSessionId });
    const taskId = `${run.id}:verifier:0`;
    const contextContent = JSON.stringify({ brief: run.executionBrief, purpose: "Apply the immutable patch and run fixed clean verification only." });
    const contextRef = await this.artifacts.saveTaskContext(owner, run.id, taskId, contextContent);
    run = await this.appendArtifacts(owner, run, [contextRef]);
    run = await this.transition(owner, run, "clean_verifying", "Running immutable patch in a fresh Sandbox verifier worktree");
    const spec = this.codeTaskSpec(run, taskId, 0, contextRef, contextRef.sha256!, {
      profile: "web-e2e-verifier",
      kind: "author",
      inputPatchRef: patchRef,
    });
    run = await this.repository.update(owner, run.id, { codeTaskIds: [...run.codeTaskIds, taskId] });
    await this.repository.addEvent(owner, run.id, "code_task.submitted", "Sandbox verifier CodeTask submitted", codeTaskMetadata(spec));
    const startedAt = Date.now();
    const executed = await submitAndWaitForCodeTask(runner, spec, { deadlineMs: spec.deadlineMs + 30_000, lostRetries: 1 });
    const result = executed.result;
    await this.repository.addEvent(owner, run.id, "code_task.completed", `Sandbox verifier CodeTask ${result.status}`, {
      ...codeTaskMetadata(executed.spec), status: result.status, durationMs: Date.now() - startedAt, provenance: result.provenance,
    });
    run = await this.persistCodeTaskEvidence(owner, run, "verifier", runner, result.artifacts.filter(item => item.kind === "log"));
    if (result.status !== "succeeded") throw new Error(`Clean verifier CodeTask failed: ${result.summary.slice(-1_500)}`);
    const changes = await this.materializePublishedChanges(runner, result.changes);
    const reviewUrl = `${this.options.reviewBaseUrl.replace(/\/$/, "")}/runs/${run.id}`;
    const pullRequestUrl = this.prBroker.publishChanges
      ? await this.prBroker.publishChanges(run, changes, reviewUrl)
      : undefined;
    if (pullRequestUrl) run = await this.repository.update(owner, run.id, { pullRequestUrl });
    else await this.repository.addEvent(owner, run.id, "pr.skipped", "Verifier passed; remote Draft PR broker is disabled");
    await this.transition(owner, run, "awaiting_qa", "Clean Sandbox verifier passed; awaiting QA review");
  }

  private codeTaskSpec(
    run: E2ERun,
    taskId: string,
    attempt: number,
    contextRef: E2ERun["artifacts"][number],
    contextHash: string,
    options: { profile: CodeTaskSpec["executionProfileId"]; kind: CodeTaskSpec["kind"]; inputPatchRef?: E2ERun["artifacts"][number] },
  ): CodeTaskSpec {
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
      fixedChecks: [{ id: "repo-install" }, { id: "playwright" }],
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
    const message = error instanceof Error ? error.message : String(error);
    const current = await this.requireRun(owner, runId);
    if (!["failed", "cancelled", "succeeded"].includes(current.status)) {
      await this.repository.update(owner, runId, { status: "failed", error: message });
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
    const repaired = await this.transition(owner, run, "repairing", `Changes requested by ${verdict.reviewerId}`);
    if (verdict.feedback) {
      await this.repository.update(owner, runId, { amendments: [...repaired.amendments, createE2EAmendment(verdict.reviewerId, verdict.feedback)] });
    }
    await this.repository.addEvent(owner, runId, "qa.feedback", verdict.feedback ?? "Changes requested");
    return repaired;
  }

  async rerun(owner: OwnerScope, runId: string): Promise<E2ERun> {
    const previous = await this.requireRun(owner, runId);
    const { pullRequestUrl: _pullRequestUrl, error: _error, ...reusable } = previous;
    const now = new Date().toISOString();
    const rerun: E2ERun = {
      ...reusable,
      id: randomUUID(),
      requestId: randomUUID(),
      status: "queued",
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

  private async installDependencies(workspace: WorkspaceRef): Promise<void> {
    const [executable, ...args] = workspace.repository.installCommand ?? [];
    if (!executable) return;
    const result = await this.workspaces.exec(workspace, executable, args, 600_000);
    if (result.exitCode !== 0) throw new Error(`Dependency hydration failed: ${result.stderr.slice(-1500)}`);
  }

  private async appendArtifacts(owner: OwnerScope, run: E2ERun, artifacts: E2ERun["artifacts"]): Promise<E2ERun> {
    return this.repository.update(owner, run.id, { artifacts: [...run.artifacts, ...artifacts] });
  }

  private async transition(owner: OwnerScope, run: E2ERun, status: E2ERun["status"], message: string): Promise<E2ERun> {
    assertRunTransition(run.status, status);
    const updated = await this.repository.update(owner, run.id, { status, ...(status === "failed" ? { error: message } : {}) });
    await this.repository.addEvent(owner, run.id, `run.${status}`, message);
    return updated;
  }

  private async requireRun(owner: OwnerScope, id: string): Promise<E2ERun> {
    const run = await this.repository.get(owner, id);
    if (!run) throw new Error(`Run ${id} not found`);
    return run;
  }
}

function isAssertionFailure(result: E2ERunResult): boolean {
  return /assertion|expect\(|expected.+received|断言/i.test(result.summary);
}

function isAssertionFailureSummary(summary: string): boolean {
  return /assertion|expect\(|expected.+received|断言/i.test(summary);
}

function isLocatorFailure(result: E2ERunResult): boolean {
  return /locator|strict mode violation|element.+not found|unable to find/i.test(result.summary);
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
