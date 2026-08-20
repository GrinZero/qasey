import { randomUUID } from "node:crypto";
import type { CreateE2ERun, E2ERun, OwnerScope, QaVerdict } from "../../contracts/src/index.ts";
import { assertRunTransition, type RunRepository } from "../../domain/src/index.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { CuaFallback } from "./cua.ts";
import type { CodingHarness } from "./harness.ts";
import type { E2ERunResult, E2ERunner } from "./runner.ts";
import type { WorkspaceManager, WorkspaceRef } from "./workspace.ts";

export interface DraftPrBroker {
  publish(run: E2ERun, workspace: WorkspaceRef, reviewUrl: string): Promise<string | undefined>;
  markReady(run: E2ERun): Promise<void>;
}

export class NoopDraftPrBroker implements DraftPrBroker {
  async publish(): Promise<undefined> { return undefined; }
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
    private readonly options: { maxRepairs: number; reviewBaseUrl: string; cua?: CuaFallback },
  ) {}

  async create(owner: OwnerScope, input: CreateE2ERun): Promise<E2ERun> {
    if ((input.platform === "web") !== (input.framework === "playwright")) throw new Error("Web requires Playwright; app requires Maestro");
    const now = new Date().toISOString();
    const run: E2ERun = {
      ...owner,
      id: randomUUID(), requestId: input.requestId ?? randomUUID(), sourceSessionId: input.sourceSessionId,
      sourceCaseIds: input.sourceCaseIds, repository: input.repository, platform: input.platform,
      framework: input.framework, status: "queued", createdAt: now, updatedAt: now, artifacts: [],
    };
    await this.repository.create(owner, run);
    await this.repository.addEvent(owner, run.id, "run.created", "E2E run queued");
    return run;
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
    let run = await this.requireRun(owner, runId);
    let author: WorkspaceRef | undefined;
    try {
      const isQaRepair = run.status === "repairing";
      run = await this.transition(owner, run, "preparing_workspace", "Preparing isolated author workspace");
      author = await this.workspaces.create(run.repository, `${run.id}-author`);
      if (isQaRepair) await this.workspaces.applyPatch(author, await this.artifacts.loadPatch(owner, run.id));
      await this.installDependencies(author);
      run = await this.repository.update(owner, run.id, { branch: author.branch });
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
    let run = await this.requireRun(owner, runId);
    let verifier: WorkspaceRef | undefined;
    try {
      const patch = await this.artifacts.loadPatch(owner, run.id);
      verifier = await this.workspaces.create(run.repository, `${run.id}-verifier`);
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
    await this.repository.addEvent(owner, runId, "qa.feedback", verdict.feedback ?? "Changes requested");
    return repaired;
  }

  async rerun(owner: OwnerScope, runId: string): Promise<E2ERun> {
    const previous = await this.requireRun(owner, runId);
    return this.create(owner, {
      sourceSessionId: previous.sourceSessionId,
      sourceCaseIds: previous.sourceCaseIds,
      repository: previous.repository,
      platform: previous.platform,
      framework: previous.framework,
    });
  }

  async cancel(owner: OwnerScope, runId: string): Promise<E2ERun> {
    const run = await this.requireRun(owner, runId);
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

function isLocatorFailure(result: E2ERunResult): boolean {
  return /locator|strict mode violation|element.+not found|unable to find/i.test(result.summary);
}
