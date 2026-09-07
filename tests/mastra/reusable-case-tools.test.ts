import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { e2eTools, preflightReusableRun, collaborationRepository, caseHubRepository, e2eCoordinator, e2ePreflight, runRepository } from "../../src/mastra/runtime.ts";
import { configureQaseyToolPermissions } from "../../src/mastra/applications/qasey/tool-permissions.ts";
import { approvedReusableVersions, assertReusableRunEnvironment } from "../../src/mastra/applications/qasey/reusable-cases.ts";
import type { PermissionService } from "../../src/platform/auth/permission-store.ts";

vi.mock("../../src/platform/code-task/e2e-repository-skill.ts", () => ({ webE2EConfigurationFromSkill: () => ({ target: { owner: "example", repository: "public-tests" }, environment: {}, verification: {} }) }));
const owner = { applicationId: "qasey", tenantId: "public-tenant" };
const versionId = "b8458e8e-f82f-46f7-9bde-4c8e52c02da9";
const version = { ...owner, id: versionId, caseId: "QASEY-1", status: "active", version: 2, title: "Public case", steps: [{ action: "Open page", expected: ["Page visible"] }] };
const authorize = vi.fn(async () => true);
const startAsync = vi.fn(async () => undefined);
const mastra = { getWorkflow: vi.fn(() => ({ createRun: async () => ({ startAsync }) })) };
function context() {
  const requestContext = new RequestContext();
  for (const [key, value] of Object.entries({ ...owner, requestId: "request-public", sessionId: "new-conversation", identity: { userId: "public-user", tenantId: owner.tenantId },
    "platform-principal": { subjectId: "public-user", tenantId: owner.tenantId, roles: ["user"], audience: "admin-ui", service: false },
    "qasey-context": { requestId: "request-public", sessionId: "new-conversation", channel: "api", chatInput: "Regenerate existing automation", actor: { id: "public-user", tenantId: owner.tenantId }, source: {}, attachments: [] },
  })) requestContext.set(key, value);
  return { requestContext, mastra } as never;
}
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); authorize.mockResolvedValue(true);
  configureQaseyToolPermissions({ authorize } as unknown as PermissionService);
  vi.spyOn(collaborationRepository, "joinRun").mockResolvedValue(undefined);
  vi.spyOn(caseHubRepository, "listCases").mockResolvedValue([{ ...owner, id: "QASEY-1", activeVersionId: versionId }] as never);
  vi.spyOn(caseHubRepository, "versionsForCase").mockResolvedValue([version] as never);
  vi.spyOn(caseHubRepository, "automationStatuses").mockResolvedValue({ [versionId]: "verified" });
  vi.spyOn(caseHubRepository, "getReviewPlan");
  vi.spyOn(caseHubRepository, "createReviewPlan");
  vi.spyOn(caseHubRepository, "createAutomationChangeSet").mockResolvedValue({ id: "new-change" } as never);
  vi.spyOn(e2ePreflight, "assertReady").mockResolvedValue({ baseSha: "a".repeat(40) } as never);
  vi.spyOn(e2eCoordinator, "create").mockResolvedValue({ ...owner, id: "new-run", sourceSessionId: "new-conversation" } as never);
  vi.spyOn(runRepository, "get").mockResolvedValue({ ...owner, id: "new-run", sourceSessionId: "new-conversation" } as never);
});
describe("cross-conversation reusable case tools", () => {
  it("starts already verified approved versions from ordinary chat without creating text assets or reading old plans", async () => {
    const result = await e2eTools().caseHubStartE2E.execute!({ caseVersionIds: [versionId] }, context());
    expect(result).toMatchObject({ run: { id: "new-run", sourceSessionId: "new-conversation" } });
    expect(caseHubRepository.createReviewPlan).not.toHaveBeenCalled();
    expect(caseHubRepository.getReviewPlan).not.toHaveBeenCalled();
    expect(caseHubRepository.createAutomationChangeSet).toHaveBeenCalledWith(owner, expect.objectContaining({ caseVersionIds: [versionId], requirement: expect.objectContaining({ source: expect.objectContaining({ sessionId: "new-conversation" }) }) }));
    expect(e2eCoordinator.create).toHaveBeenCalledWith(owner, expect.objectContaining({ sourceSessionId: "new-conversation" }), expect.anything());
    expect(startAsync).toHaveBeenCalledTimes(1);
  });
  it("rejects reruns of an active source before running preflight or creating assets", async () => {
    await expect(preflightReusableRun(owner, { status: "author_running" } as never, {} as never)).rejects.toThrow("still active");
    expect(e2ePreflight.assertReady).not.toHaveBeenCalled();
    expect(e2eCoordinator.create).not.toHaveBeenCalled();
  });
  it("enforces e2e permission before reading case assets or creating a run", async () => {
    authorize.mockResolvedValue(false);
    await expect(e2eTools().caseHubStartE2E.execute!({ caseVersionIds: [versionId] }, context())).rejects.toThrow("qasey.e2e.execute");
    expect(caseHubRepository.listCases).not.toHaveBeenCalled();
    expect(e2eCoordinator.create).not.toHaveBeenCalled();
  });
  it("rejects stale, deleted, unapproved, foreign and duplicate version selections", async () => {
    for (const ids of [["missing"], [versionId, versionId]]) await expect(approvedReusableVersions(caseHubRepository, owner, ids)).rejects.toThrow();
    vi.mocked(caseHubRepository.versionsForCase).mockResolvedValue([{ ...version, tenantId: "other-tenant" }] as never);
    await expect(approvedReusableVersions(caseHubRepository, owner, [versionId])).rejects.toThrow("approved");
    vi.mocked(caseHubRepository.versionsForCase).mockResolvedValue([{ ...version, status: "proposed" }] as never);
    await expect(approvedReusableVersions(caseHubRepository, owner, [versionId])).rejects.toThrow("approved");
  });
  it("does not alter an explicit trusted action selection", async () => {
    const execution = context() as { requestContext: RequestContext };
    execution.requestContext.set("qasey-conversation-action", { type: "generate_e2e", planId: "c357271e-c9b9-47fb-8799-afdf80df3554", caseVersionIds: [versionId], clientMessageId: "c357271e-c9b9-47fb-8799-afdf80df3555" });
    await expect(e2eTools().caseHubStartE2E.execute!({ caseVersionIds: [versionId] }, execution as never)).rejects.toThrow("exact trusted");
    expect(e2eCoordinator.create).not.toHaveBeenCalled();
  });
});


describe("reused patch deployment boundary", () => {
  const sha = "a".repeat(40);
  const environment = { id: "public-preview", baseUrl: "https://preview.example.test" };
  const repository = { owner: "example", repository: "public-tests" };
  const run = { baseSha: sha, repository, testEnvironment: environment } as never;
  const changeSet = { baseSha: sha, environmentSourceSha: sha } as never;
  const configuration = { target: repository } as never;
  const preflight = { baseSha: sha, environmentSourceSha: sha, testEnvironment: environment };
  it("keeps the pinned patch on the same verified deployment", () => {
    expect(() => assertReusableRunEnvironment(run, changeSet, preflight, configuration)).not.toThrow();
  });
  it.each([
    { ...preflight, baseSha: "b".repeat(40) },
    { ...preflight, environmentSourceSha: "b".repeat(40) },
    { ...preflight, testEnvironment: { ...environment, id: "another-preview" } },
  ])("rejects revision or environment changes without silently rebasing: %j", snapshot => {
    expect(() => assertReusableRunEnvironment(run, changeSet, snapshot, configuration)).toThrow("do not change their text versions");
  });
});
