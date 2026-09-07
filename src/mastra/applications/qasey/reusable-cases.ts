import { RequirementDraftSchema, type CaseHubCaseVersion, type OwnerScope } from "../../../../packages/contracts/src/index.ts";
import type { CaseHubRepository } from "../../../../packages/domain/src/case-hub-repository.ts";

/** Resolve only published tenant assets; never load their originating conversation or review plan. */
export async function approvedReusableVersions(repository: CaseHubRepository, owner: OwnerScope, ids: string[]): Promise<CaseHubCaseVersion[]> {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error("Select 1–100 unique approved Case Versions");
  const cases = (await repository.listCases(owner)).filter(item => item.activeVersionId && ids.includes(item.activeVersionId));
  if (cases.length !== ids.length) throw new Error("One or more Case Versions are missing, deleted, unapproved, or stale");
  const versions = (await Promise.all(cases.map(item => repository.versionsForCase(owner, item.id)))).flat();
  return ids.map(id => {
    const version = versions.find(item => item.id === id && item.status === "active"
      && item.applicationId === owner.applicationId && item.tenantId === owner.tenantId);
    if (!version) throw new Error("E2E requires active approved Case Versions");
    return version;
  });
}

export function reusableCaseRequirement(versions: CaseHubCaseVersion[]) {
  return RequirementDraftSchema.parse({
    goal: "Implement automation for the selected approved Case Hub versions",
    requirementSummary: `Generate or maintain Playwright automation for existing approved cases: ${versions.map(item => `${item.caseId} v${item.version}: ${item.title}`).join("; ")}`.slice(0, 24_000),
    inScope: versions.map(item => `${item.caseId}: ${item.title}`.slice(0, 2000)),
    constraints: ["Reuse the exact approved text versions. Preserve every step and expected outcome; automation implementation changes do not create text versions."],
  });
}

/** Reusing a patch also reuses its pinned product revision; never silently rebase old evidence. */
export function assertReusableRunEnvironment(
  run: import("../../../../packages/contracts/src/index.ts").E2ERun,
  changeSet: import("../../../../packages/contracts/src/index.ts").CaseHubChangeSet,
  preflight: Pick<import("../../../platform/e2e/preflight.ts").E2EPreflightSnapshot, "baseSha" | "environmentSourceSha" | "testEnvironment">,
  configuration: import("../../../platform/code-task/e2e-repository-skill.ts").WebE2EConfiguration,
): void {
  const pinnedSha = run.baseSha ?? changeSet.baseSha;
  const revisionMismatch = !pinnedSha || preflight.baseSha !== pinnedSha || preflight.environmentSourceSha !== pinnedSha
    || Boolean(changeSet.environmentSourceSha && changeSet.environmentSourceSha !== pinnedSha);
  const targetMismatch = run.repository.owner !== configuration.target.owner || run.repository.repository !== configuration.target.repository
    || run.testEnvironment?.id !== preflight.testEnvironment.id || run.testEnvironment?.baseUrl !== preflight.testEnvironment.baseUrl;
  if (revisionMismatch || targetMismatch) throw new Error("The source run's pinned repository revision or test environment no longer matches the deployment. Generate a new automation run for the explicitly selected approved case versions; do not change their text versions or silently rebase this run.");
}
