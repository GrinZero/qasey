import { randomUUID } from "node:crypto";
import type { CreateE2ERun, E2ERun, QaVerdict } from "../../contracts/src/index.ts";
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

  async create(input: CreateE2ERun): Promise<E2ERun> {
    if ((input.platform === "web") !== (input.framework === "playwright")) throw new Error("Web requires Playwright; app requires Maestro");
    const now = new Date().toISOString();
    const run: E2ERun = {
      id: randomUUID(), requestId: input.requestId ?? randomUUID(), sourceSessionId: input.sourceSessionId,
      sourceCaseIds: input.sourceCaseIds, repository: input.repository, platform: input.platform,
      framework: input.framework, status: "queued", createdAt: now, updatedAt: now, artifacts: [],
    };
    await this.repository.create(run);
    await this.repository.addEvent(run.id, "run.created", "E2E run queued");
    return run;
  }

  async execute(runId: string, qaFeedback?: string): Promise<void> {
    try {
      await this.authorAndPersistPatch(runId, qaFeedback);
      await this.cleanVerifyAndPublish(runId);
    } catch (error) {
      await this.fail(runId, error);
    }
  }

  async authorAndPersistPatch(runId: string, qaFeedback?: string): Promise<void> {
    let run = await this.requireRun(runId);
    let author: WorkspaceRef | undefined;
    try {
      const isQaRepair = run.status === "repairing";
      run = await this.transition(run, "preparing_workspace", "Preparing isolated author workspace");
      author = await this.workspaces.create(run.repository, `${run.id}-author`);
      if (isQaRepair) await this.workspaces.applyPatch(author, await this.artifacts.loadPatch(run.id));
      await this.installDependencies(author);
      run = await this.repository.update(run.id, { branch: author.branch });
      run = await this.transition(run, "authoring", isQaRepair ? "Applying QA feedback in ACP coding harness" : "Delegating E2E authoring to ACP coding harness");
      await this.harness.author({
        runId: run.id, framework: run.framework, sourceCaseIds: run.sourceCaseIds,
        instruction: qaFeedback
          ? `QA requested these changes:\n${qaFeedback}\nUpdate only the E2E implementation, then run repository checks.`
          : "Implement the accepted QA cases, then run repository checks. Preserve product code unless a test-enablement change is explicitly allowed.",
      }, author);

      let authorResult: E2ERunResult | undefined;
      for (let repair = 0; repair <= this.options.maxRepairs; repair += 1) {
        await this.workspaces.assertAllowedChanges(author);
        run = await this.transition(run, "author_running", `Running ${run.framework} in author workspace (attempt ${repair + 1})`);
        authorResult = await this.runners[run.framework].run(author, `${run.id}:author:${repair}`);
        run = await this.appendArtifacts(run, await this.artifacts.persist(run.id, "author", authorResult.artifacts));
        if (authorResult.passed) break;
        if (isAssertionFailure(authorResult) || repair === this.options.maxRepairs) {
          throw new Error(`Author run failed without an eligible repair: ${authorResult.summary.slice(-1500)}`);
        }
        run = await this.transition(run, "repairing", `Author run failed; starting bounded repair ${repair + 1}`);
        let exploration = "";
        if (isLocatorFailure(authorResult) && repair === this.options.maxRepairs - 1 && this.options.cua) {
          const observed = await this.options.cua.observe(author, run.id, "Observe the failing UI flow and suggest deterministic Playwright/Maestro steps. Do not judge pass/fail.");
          run = await this.appendArtifacts(run, await this.artifacts.persist(run.id, "author", observed.artifacts));
          exploration = `\nCua observation (advisory only):\n${observed.summary}`;
        }
        await this.harness.author({
          runId: run.id, framework: run.framework, sourceCaseIds: run.sourceCaseIds,
          instruction: `Repair only the test implementation. Do not weaken assertions. Runner output:\n${authorResult.summary}${exploration}`,
        }, author);
      }
      if (!authorResult?.passed) throw new Error("Author run did not pass");
      await this.workspaces.assertAllowedChanges(author);
      const patch = await this.workspaces.collectPatch(author);
      run = await this.appendArtifacts(run, [await this.artifacts.savePatch(run.id, patch)]);
    } finally {
      if (author) await this.workspaces.destroy(author).catch(() => undefined);
    }
  }

  async cleanVerifyAndPublish(runId: string): Promise<void> {
    let run = await this.requireRun(runId);
    let verifier: WorkspaceRef | undefined;
    try {
      const patch = await this.artifacts.loadPatch(run.id);
      verifier = await this.workspaces.create(run.repository, `${run.id}-verifier`);
      await this.workspaces.applyPatch(verifier, patch);
      await this.installDependencies(verifier);
      run = await this.transition(run, "clean_verifying", "Running immutable patch in a fresh verifier workspace");
      const verifierResult = await this.runners[run.framework].run(verifier, `${run.id}:verifier`);
      run = await this.appendArtifacts(run, await this.artifacts.persist(run.id, "verifier", verifierResult.artifacts));
      if (!verifierResult.passed) throw new Error(`Clean verifier failed: ${verifierResult.summary.slice(-1500)}`);
      const reviewUrl = `${this.options.reviewBaseUrl.replace(/\/$/, "")}/runs/${run.id}`;
      const pullRequestUrl = await this.prBroker.publish(run, verifier, reviewUrl);
      if (pullRequestUrl) run = await this.repository.update(run.id, { pullRequestUrl });
      else await this.repository.addEvent(run.id, "pr.skipped", "Verifier passed; Draft PR broker is disabled");
      await this.transition(run, "awaiting_qa", "Clean verifier passed; awaiting QA review");
    } finally {
      if (verifier) await this.workspaces.destroy(verifier).catch(() => undefined);
    }
  }

  async fail(runId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const current = await this.requireRun(runId);
    if (!["failed", "cancelled", "succeeded"].includes(current.status)) {
      await this.repository.update(runId, { status: "failed", error: message });
      await this.repository.addEvent(runId, "run.failed", message);
    }
  }

  async verdict(runId: string, verdict: QaVerdict): Promise<E2ERun> {
    const run = await this.requireRun(runId);
    if (run.status !== "awaiting_qa") throw new Error("QA verdict requires awaiting_qa status");
    if (verdict.verdict === "approve") {
      if (run.pullRequestUrl) await this.prBroker.markReady(run);
      return this.transition(run, "succeeded", `Approved by ${verdict.reviewerId}; Draft PR marked ready`);
    }
    const repaired = await this.transition(run, "repairing", `Changes requested by ${verdict.reviewerId}`);
    await this.repository.addEvent(runId, "qa.feedback", verdict.feedback ?? "Changes requested");
    return repaired;
  }

  async rerun(runId: string): Promise<E2ERun> {
    const previous = await this.requireRun(runId);
    return this.create({
      sourceSessionId: previous.sourceSessionId,
      sourceCaseIds: previous.sourceCaseIds,
      repository: previous.repository,
      platform: previous.platform,
      framework: previous.framework,
    });
  }

  async cancel(runId: string): Promise<E2ERun> {
    const run = await this.requireRun(runId);
    return this.transition(run, "cancelled", "Run cancelled");
  }

  private async installDependencies(workspace: WorkspaceRef): Promise<void> {
    const [executable, ...args] = workspace.repository.installCommand ?? [];
    if (!executable) return;
    const result = await this.workspaces.exec(workspace, executable, args, 600_000);
    if (result.exitCode !== 0) throw new Error(`Dependency hydration failed: ${result.stderr.slice(-1500)}`);
  }

  private async appendArtifacts(run: E2ERun, artifacts: E2ERun["artifacts"]): Promise<E2ERun> {
    return this.repository.update(run.id, { artifacts: [...run.artifacts, ...artifacts] });
  }

  private async transition(run: E2ERun, status: E2ERun["status"], message: string): Promise<E2ERun> {
    assertRunTransition(run.status, status);
    const updated = await this.repository.update(run.id, { status, ...(status === "failed" ? { error: message } : {}) });
    await this.repository.addEvent(run.id, `run.${status}`, message);
    return updated;
  }

  private async requireRun(id: string): Promise<E2ERun> {
    const run = await this.repository.get(id);
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
