import { z } from "zod";
import type { UIMessage } from "ai";

export const OwnerScopeSchema = z.object({
  applicationId: z.string().min(1),
  tenantId: z.string().min(1),
});
export type OwnerScope = z.infer<typeof OwnerScopeSchema>;

export const QaseyChannelSchema = z.enum(["slack", "jira", "api"]);
export type QaseyChannel = z.infer<typeof QaseyChannelSchema>;

export const AttachmentRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  url: z.url().optional(),
  source: z.enum(["slack", "jira", "api"]),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const QaseyRequestContextSchema = z.object({
  requestId: z.string().min(1),
  channel: QaseyChannelSchema,
  sessionId: z.string().min(1),
  chatInput: z.string().trim().min(1),
  actor: z.object({
    id: z.string().min(1),
    displayName: z.string().optional(),
    tenantId: z.string().min(1).optional(),
  }),
  source: z.object({
    channelId: z.string().optional(),
    threadTs: z.string().optional(),
    issueKey: z.string().optional(),
    commentId: z.string().optional(),
    sourceUrl: z.url().optional(),
  }),
  attachments: z.array(AttachmentRefSchema).default([]),
});
export type QaseyRequestContext = z.infer<typeof QaseyRequestContextSchema>;

export const QaseyConversationSchema = z.object({
  applicationId: z.literal("qasey"),
  tenantId: z.string().min(1),
  id: z.string().uuid(),
  subjectId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  activeTurnId: z.string().uuid().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type QaseyConversation = z.infer<typeof QaseyConversationSchema>;

export const QaseyConversationTurnStatusSchema = z.enum(["running", "completed", "failed"]);
export const QaseyConversationTurnSchema = z.object({
  applicationId: z.literal("qasey"),
  tenantId: z.string().min(1),
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  clientMessageId: z.string().uuid(),
  userMessage: z.string().trim().min(1).max(100_000),
  assistantText: z.string().default(""),
  status: QaseyConversationTurnStatusSchema,
  agentRunId: z.string().uuid().optional(),
  linkedRunId: z.string().uuid().optional(),
  error: z.string().max(2_000).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type QaseyConversationTurn = z.infer<typeof QaseyConversationTurnSchema>;

export const QaseyConversationEventTypeSchema = z.enum([
  "accepted", "assistant.delta", "progress", "tool.started", "tool.finished", "run.linked", "completed", "failed",
]);
export type QaseyConversationEventType = z.infer<typeof QaseyConversationEventTypeSchema>;
export const QaseyConversationEventSchema = z.object({
  applicationId: z.literal("qasey"),
  tenantId: z.string().min(1),
  conversationId: z.string().uuid(),
  turnId: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: QaseyConversationEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.iso.datetime(),
}).strict();
export type QaseyConversationEvent = z.infer<typeof QaseyConversationEventSchema>;

export const QaseyUIMessageMetadataSchema = z.object({
  conversationId: z.string().uuid(),
  turnId: z.string().uuid(),
  createdAt: z.iso.datetime(),
  latestSequence: z.number().int().nonnegative(),
  linkedRunId: z.string().uuid().optional(),
}).strict();
export type QaseyUIMessageMetadata = z.infer<typeof QaseyUIMessageMetadataSchema>;

export const QaseyProgressDataSchema = z.object({
  sequence: z.number().int().positive(),
  title: z.string().min(1).max(100),
  detail: z.string().max(1_200),
  status: z.enum(["working", "waiting", "blocked", "completed", "failed"]),
  milestone: z.string().max(64).optional(),
  next: z.string().max(500).optional(),
}).strict();
export type QaseyProgressData = z.infer<typeof QaseyProgressDataSchema>;

export const QaseyRunDataSchema = z.object({
  runId: z.string().uuid(),
}).strict();
export type QaseyRunData = z.infer<typeof QaseyRunDataSchema>;

export const QaseyCursorDataSchema = z.object({
  sequence: z.number().int().positive(),
}).strict();
export type QaseyCursorData = z.infer<typeof QaseyCursorDataSchema>;

export type QaseyUIDataTypes = {
  progress: QaseyProgressData;
  run: QaseyRunData;
  cursor: QaseyCursorData;
};
export type QaseyUIMessage = UIMessage<QaseyUIMessageMetadata, QaseyUIDataTypes>;

export const QaseyPublicToolInputSchema = z.object({
  summary: z.string().trim().min(1).max(500),
}).strict();
export type QaseyPublicToolInput = z.infer<typeof QaseyPublicToolInputSchema>;

export const QaseyPublicToolOutputSchema = z.object({
  summary: z.string().trim().min(1).max(500),
}).strict();
export type QaseyPublicToolOutput = z.infer<typeof QaseyPublicToolOutputSchema>;

const QaseyUITextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  state: z.enum(["streaming", "done"]).optional(),
}).passthrough();
const QaseyUIProgressPartSchema = z.object({
  type: z.literal("data-progress"),
  id: z.string().min(1).optional(),
  data: QaseyProgressDataSchema,
}).strict();
const QaseyUIRunPartSchema = z.object({
  type: z.literal("data-run"),
  id: z.string().min(1).optional(),
  data: QaseyRunDataSchema,
}).strict();
const QaseyUICursorPartSchema = z.object({
  type: z.literal("data-cursor"),
  id: z.string().min(1).optional(),
  data: QaseyCursorDataSchema,
}).strict();
const QaseyUIDynamicToolBaseSchema = z.object({
  type: z.literal("dynamic-tool"),
  toolName: z.string().min(1).max(256),
  toolCallId: z.string().min(1).max(256),
  title: z.string().min(1).max(100).optional(),
  providerExecuted: z.boolean().optional(),
  // AI SDK's stream reducer materializes this key with `undefined` while
  // replacing an input part with its result. No raw input is accepted here.
  rawInput: z.never().optional(),
});
const QaseyUIDynamicToolPartSchema = z.discriminatedUnion("state", [
  QaseyUIDynamicToolBaseSchema.extend({
    state: z.literal("input-available"),
    input: QaseyPublicToolInputSchema,
    output: z.never().optional(),
    errorText: z.never().optional(),
    preliminary: z.never().optional(),
  }).strict(),
  QaseyUIDynamicToolBaseSchema.extend({
    state: z.literal("output-available"),
    input: QaseyPublicToolInputSchema,
    output: QaseyPublicToolOutputSchema,
    errorText: z.never().optional(),
    preliminary: z.boolean().optional(),
  }).strict(),
  QaseyUIDynamicToolBaseSchema.extend({
    state: z.literal("output-error"),
    input: QaseyPublicToolInputSchema,
    errorText: z.string().min(1).max(500),
    output: z.never().optional(),
    preliminary: z.never().optional(),
  }).strict(),
]);

export const QaseyUIMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  metadata: QaseyUIMessageMetadataSchema,
  parts: z.array(z.union([
    QaseyUITextPartSchema,
    QaseyUIProgressPartSchema,
    QaseyUIRunPartSchema,
    QaseyUICursorPartSchema,
    QaseyUIDynamicToolPartSchema,
  ])),
}).strict();

export const AgentProgressInputSchema = z.object({
  milestone: z.string().trim().min(2).max(64).regex(/^[a-z][a-z0-9_-]*$/u),
  title: z.string().trim().min(2).max(100),
  detail: z.string().trim().min(2).max(1_200),
  next: z.string().trim().min(2).max(500).optional(),
  status: z.enum(["working", "waiting", "blocked"]).default("working"),
});
export type AgentProgressInput = z.input<typeof AgentProgressInputSchema>;

export const AgentProgressReportSchema = AgentProgressInputSchema.extend({
  sequence: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
});
export type AgentProgressReport = z.infer<typeof AgentProgressReportSchema>;

export const ToolEffectSchema = z.enum(["read", "write", "delete", "message", "approval"]);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

export const ToolPolicySchema = z.object({
  effect: ToolEffectSchema,
  allowedChannels: z.array(QaseyChannelSchema),
  requiresApproval: z.boolean(),
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export const E2EFrameworkSchema = z.enum(["playwright", "maestro"]);
export type E2EFramework = z.infer<typeof E2EFrameworkSchema>;
export const E2EPlatformSchema = z.enum(["web", "app"]);
export type E2EPlatform = z.infer<typeof E2EPlatformSchema>;

export const TestCaseSpecSchema = z.object({
  id: z.string().min(1),
  versionHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  automationPath: z.string().min(1).optional(),
  requirementId: z.string().optional(),
  title: z.string().min(1),
  target: z.enum(["web", "ios", "android"]),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  evidenceRefs: z.array(z.object({ source: z.string(), ref: z.string() })),
  preconditions: z.array(z.string()),
  steps: z.array(z.object({ action: z.string().min(1), expected: z.array(z.string().min(1)).min(1) })).min(1),
  testData: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  unresolvedQuestions: z.array(z.string()),
});
export type TestCaseSpec = z.infer<typeof TestCaseSpecSchema>;
export const RunStatusSchema = z.enum([
  "queued",
  "preparing_workspace",
  "authoring",
  "author_running",
  "repairing",
  "clean_verifying",
  "awaiting_qa",
  "succeeded",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const E2EProjectSkillPathSchema = z.string().min(1).max(1_000)
  .refine(value => !value.startsWith("/") && !value.startsWith("\\"), "E2E project Skill path must be relative")
  .refine(value => !value.includes("\\"), "E2E project Skill path must use canonical POSIX separators")
  .refine(value => value.split("/").every(segment => segment !== "." && segment !== ".." && segment.length > 0), "E2E project Skill path cannot contain dot or empty segments")
  .refine(value => value === "SKILL.md" || value.endsWith("/SKILL.md"), "E2E project Skill path must point to a SKILL.md file");

export const E2EAuthenticationSetupPathSchema = z.string().min(1).max(1_000)
  .refine(value => !value.startsWith("/") && !value.startsWith("\\"), "E2E authentication setup path must be relative")
  .refine(value => !value.includes("\\"), "E2E authentication setup path must use canonical POSIX separators")
  .refine(value => value.split("/").every(segment => segment !== "." && segment !== ".." && segment.length > 0), "E2E authentication setup path cannot contain dot or empty segments")
  .refine(value => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(value), "E2E authentication setup path must point to executable JavaScript or TypeScript");

const E2EAuthenticationEnvironmentNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/u);

function validateE2EAuthenticationEnvironment(
  value: readonly string[],
  context: z.RefinementCtx,
  pathPrefix: Array<string | number> = [],
): void {
  const reserved = new Set(["BASE_URL", "CI", "HOME", "PATH", "PLAYWRIGHT_BROWSERS_PATH"]);
  const names = new Set<string>();
  for (const [index, name] of value.entries()) {
    if (names.has(name)) {
      context.addIssue({ code: "custom", path: [...pathPrefix, index], message: `Authentication environment variable ${name} is duplicated` });
    }
    if (reserved.has(name) || name.startsWith("QASEY_")) {
      context.addIssue({
        code: "custom",
        path: [...pathPrefix, index],
        message: `Authentication environment variable ${name} is reserved by the verifier`,
      });
    }
    names.add(name);
  }
}

export const E2EAuthenticationSchema = z.object({
  strategy: z.literal("repository-playwright-setup"),
  setupPath: E2EAuthenticationSetupPathSchema,
  setupProject: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/u),
  requiredEnvironment: z.array(E2EAuthenticationEnvironmentNameSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  validateE2EAuthenticationEnvironment(value.requiredEnvironment, context, ["requiredEnvironment"]);
});
export type E2EAuthentication = z.infer<typeof E2EAuthenticationSchema>;

export const RepositoryProfileSchema = z.object({
  owner: z.string().min(1),
  repository: z.string().min(1),
  cloneUrl: z.string().min(1),
  baseRef: z.string().min(1).default("main"),
  allowedPaths: z.array(z.string().min(1)).min(1),
  skillsPaths: z.array(z.string()).default([".agents/skills", ".claude/skills", "skills"]),
  e2eSkillPath: E2EProjectSkillPathSchema.optional(),
  e2eAuthentication: E2EAuthenticationSchema.optional(),
  installCommand: z.array(z.string()).optional(),
});
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;

export const E2ETestEnvironmentSchema = z.object({
  id: z.string().min(1).max(100),
  baseUrl: z.url(),
}).strict();
export type E2ETestEnvironment = z.infer<typeof E2ETestEnvironmentSchema>;

export const ArtifactRefSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["log", "trace", "video", "screenshot", "report", "patch", "trajectory"]),
  name: z.string().min(1),
  uri: z.string().min(1),
  contentType: z.string().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const E2EEvidenceRefSchema = z.object({
  kind: z.enum(["message", "attachment", "document", "case", "repository"]),
  ref: z.string().min(1),
  title: z.string().min(1).max(500).optional(),
  summary: z.string().max(8_000).optional(),
});
export type E2EEvidenceRef = z.infer<typeof E2EEvidenceRefSchema>;

export const E2EContextDraftSchema = z.object({
  goal: z.string().min(1).max(8_000),
  requirementSummary: z.string().min(1).max(24_000),
  inScope: z.array(z.string().min(1).max(2_000)).max(100).default([]),
  outOfScope: z.array(z.string().min(1).max(2_000)).max(100).default([]),
  confirmedDecisions: z.array(z.string().min(1).max(4_000)).max(100).default([]),
  constraints: z.array(z.string().min(1).max(4_000)).max(100).default([]),
  assumptions: z.array(z.string().min(1).max(4_000)).max(100).default([]),
  criticalFlows: z.array(z.string().min(1).max(4_000)).max(200).default([]),
  boundaryCases: z.array(z.string().min(1).max(4_000)).max(200).default([]),
  negativeCases: z.array(z.string().min(1).max(4_000)).max(200).default([]),
  testDataNeeds: z.array(z.string().min(1).max(4_000)).max(100).default([]),
  repositoryFindings: z.array(z.string().min(1).max(4_000)).max(200).default([]),
  blockingQuestions: z.array(z.string().min(1).max(4_000)).max(100).default([]),
  evidenceRefs: z.array(E2EEvidenceRefSchema).max(200).default([]),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) {
    context.addIssue({ code: "custom", message: "E2E handoff exceeds the 64 KiB snapshot limit" });
  }
});
export type E2EContextDraft = z.infer<typeof E2EContextDraftSchema>;

export const E2EContextSnapshotSchema = E2EContextDraftSchema.safeExtend({
  version: z.literal(1),
  source: z.object({
    sessionId: z.string().min(1),
    threadId: z.string().min(1),
    taskRunId: z.string().min(1),
    requestId: z.string().min(1),
    resourceId: z.string().min(1),
  }).strict(),
  createdAt: z.iso.datetime(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type E2EContextSnapshot = z.infer<typeof E2EContextSnapshotSchema>;

// Requirement snapshots are channel-neutral and are shared by Case Hub and
// the E2E execution plane. Keep the E2E aliases above while callers migrate.
export const RequirementDraftSchema = E2EContextDraftSchema;
export type RequirementDraft = E2EContextDraft;
export const RequirementSnapshotSchema = E2EContextSnapshotSchema;
export type RequirementSnapshot = E2EContextSnapshot;

export const CaseHubProjectCodeSchema = z.literal("QASEY");
export const CaseHubCaseIdSchema = z.string().regex(/^QASEY-[1-9][0-9]*$/u);
export const CaseHubCaseVersionStatusSchema = z.enum(["proposed", "approved", "active", "rejected"]);
export const CaseHubChangeSetStatusSchema = z.enum([
  "authoring", "verifying", "awaiting_review", "revising", "blocked_product",
  "blocked_environment", "final_verifying", "ready_to_merge", "merged", "failed",
  "cancelled", "abandoned",
]);
export type CaseHubChangeSetStatus = z.infer<typeof CaseHubChangeSetStatusSchema>;
export const CaseHubExecutionStatusSchema = z.enum(["passed", "failed", "blocked", "skipped"]);
export const CaseHubReviewStatusSchema = z.enum([
  "pending", "approved", "changes_requested", "product_bug", "environment_issue",
]);

export const CaseHubCaseProposalSchema = z.object({
  operation: z.enum(["create", "update"]),
  caseId: CaseHubCaseIdSchema.optional(),
  suitePath: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(8_000).default(""),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  preconditions: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
  steps: z.array(z.object({
    action: z.string().trim().min(1).max(4_000),
    expected: z.array(z.string().trim().min(1).max(4_000)).min(1).max(20),
  }).strict()).min(1).max(200),
  testData: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  automationPath: z.string().trim().min(1).max(1_000),
  evidenceRefs: z.array(E2EEvidenceRefSchema).max(200).default([]),
}).strict().superRefine((value, context) => {
  if (value.operation === "update" && !value.caseId) {
    context.addIssue({ code: "custom", path: ["caseId"], message: "Update proposals require a caseId" });
  }
  if (value.operation === "create" && value.caseId) {
    context.addIssue({ code: "custom", path: ["caseId"], message: "Create proposals receive a server-owned caseId" });
  }
});
export type CaseHubCaseProposal = z.infer<typeof CaseHubCaseProposalSchema>;

export const CreateCaseHubChangeSetSchema = z.object({
  requirement: RequirementDraftSchema,
  proposals: z.array(CaseHubCaseProposalSchema).min(1).max(100),
}).strict();
export type CreateCaseHubChangeSet = z.infer<typeof CreateCaseHubChangeSetSchema>;

export const CaseHubCaseVersionSchema = z.object({
  applicationId: z.string().min(1),
  tenantId: z.string().min(1),
  id: z.string().uuid(),
  caseId: CaseHubCaseIdSchema,
  projectCode: CaseHubProjectCodeSchema,
  version: z.number().int().positive(),
  suitePath: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  target: z.literal("web"),
  preconditions: z.array(z.string()),
  steps: TestCaseSpecSchema.shape.steps,
  testData: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  automationPath: z.string().min(1),
  evidenceRefs: z.array(E2EEvidenceRefSchema),
  requirementSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  status: CaseHubCaseVersionStatusSchema,
  createdBy: z.string().min(1),
  createdAt: z.iso.datetime(),
}).strict();
export type CaseHubCaseVersion = z.infer<typeof CaseHubCaseVersionSchema>;

export const CaseHubCaseSchema = z.object({
  applicationId: z.string().min(1),
  tenantId: z.string().min(1),
  id: CaseHubCaseIdSchema,
  projectCode: CaseHubProjectCodeSchema,
  suitePath: z.string().min(1),
  title: z.string().min(1),
  activeVersionId: z.string().uuid().optional(),
  proposedVersionIds: z.array(z.string().uuid()).default([]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type CaseHubCase = z.infer<typeof CaseHubCaseSchema>;

export const CaseHubChangeSetSchema = z.object({
  applicationId: z.string().min(1),
  tenantId: z.string().min(1),
  id: z.string().uuid(),
  projectCode: CaseHubProjectCodeSchema,
  requirement: RequirementSnapshotSchema,
  caseVersionIds: z.array(z.string().uuid()).min(1),
  candidateCaseSequenceRange: z.object({
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  }).strict().refine(value => value.end >= value.start, "Candidate Case sequence range must be ordered").optional(),
  caseIdsFinalized: z.boolean().default(false),
  planHash: z.string().regex(/^[a-f0-9]{64}$/u),
  status: CaseHubChangeSetStatusSchema,
  revision: z.number().int().positive(),
  repository: RepositoryProfileSchema,
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
  environmentSourceSha: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
  runId: z.string().uuid().optional(),
  branch: z.string().optional(),
  pullRequestUrl: z.url().optional(),
  error: z.string().optional(),
  createdBy: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type CaseHubChangeSet = z.infer<typeof CaseHubChangeSetSchema>;

export const CaseHubResultSchema = z.object({
  applicationId: z.string().min(1),
  tenantId: z.string().min(1),
  id: z.string().uuid(),
  changeSetId: z.string().uuid(),
  runId: z.string().uuid(),
  caseVersionId: z.string().uuid(),
  caseId: CaseHubCaseIdSchema,
  attempt: z.number().int().positive(),
  executionStatus: CaseHubExecutionStatusSchema,
  reviewStatus: CaseHubReviewStatusSchema,
  reviewerId: z.string().optional(),
  feedback: z.string().max(5_000).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  testCodeHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  artifacts: z.array(ArtifactRefSchema).default([]),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().optional(),
}).strict();
export type CaseHubResult = z.infer<typeof CaseHubResultSchema>;

export const CaseHubResultReviewInputSchema = z.object({
  verdict: z.enum(["approve", "request_changes", "product_bug", "environment_issue"]),
  feedback: z.string().trim().max(5_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.verdict !== "approve" && !value.feedback) {
    context.addIssue({ code: "custom", path: ["feedback"], message: "Feedback is required for non-approval verdicts" });
  }
});

export const CodeTaskKindSchema = z.enum(["author", "repair", "review", "migration-author"]);
export const CodeTaskStatusSchema = z.enum([
  "queued", "running", "cancel_requested", "succeeded", "failed", "cancelled", "lost",
]);
export const CodeTaskScopeSchema = z.object({
  applicationId: z.string().min(1),
  tenantId: z.string().min(1),
  sessionId: z.string().min(1),
}).strict();
const RelativeWorkspacePathSchema = z.string().min(1).max(1_000)
  .refine(value => !value.startsWith("/") && !value.startsWith("\\"), "Workspace paths must be relative")
  .refine(value => value.split(/[\\/]/u).every(segment => segment !== "." && segment !== ".." && segment.length > 0), "Workspace paths cannot contain dot or empty segments");
const PlaywrightVerificationPathSchema = RelativeWorkspacePathSchema
  .refine(value => !value.includes("\\"), "Playwright verification paths must use canonical POSIX separators");
const ChangedProjectPlaywrightProjectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u).max(100),
  root: PlaywrightVerificationPathSchema,
  testRoot: PlaywrightVerificationPathSchema,
  config: PlaywrightVerificationPathSchema,
  playwrightProject: z.string().min(1).max(100),
}).strict();
export const ChangedProjectPlaywrightVerificationSchema = z.object({
  strategy: z.literal("changed-project-playwright"),
  projects: z.array(ChangedProjectPlaywrightProjectSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, project] of value.projects.entries()) {
    if (ids.has(project.id)) {
      context.addIssue({
        code: "custom",
        path: ["projects", index, "id"],
        message: `Playwright verification project id ${project.id} is duplicated`,
      });
    }
    ids.add(project.id);
    for (const field of ["testRoot", "config"] as const) {
      if (!workspacePathIsWithin(project[field], project.root)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, field],
          message: `${field} must be contained by the project root`,
        });
      }
    }
  }
});
export type ChangedProjectPlaywrightVerification = z.infer<typeof ChangedProjectPlaywrightVerificationSchema>;

function workspacePathIsWithin(path: string, root: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
export const RepositoryMountSchema = z.object({
  owner: z.string().min(1),
  repository: z.string().min(1),
  destination: RelativeWorkspacePathSchema,
  mode: z.enum(["read", "write"]),
  baseRef: z.string().min(1).default("main"),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
}).strict();
export const FixedCheckRefSchema = z.object({ id: z.string().min(1).max(100) }).strict();
export const CodeTaskTraceContextSchema = z.object({
  traceId: z.string().min(1).optional(),
  parentSpanId: z.string().min(1).optional(),
  traceparent: z.string().min(1).optional(),
}).strict();
export type CodeTaskTraceContext = z.infer<typeof CodeTaskTraceContextSchema>;

export const CodeTaskSpecSchema = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/u),
  attemptId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/u),
  kind: CodeTaskKindSchema,
  scope: CodeTaskScopeSchema,
  contextRef: ArtifactRefSchema,
  contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
  repositories: z.array(RepositoryMountSchema).min(1).max(8),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
  executionProfileId: z.enum(["web-e2e-author", "web-e2e-repair", "web-e2e-verifier", "code-review-readonly"]),
  allowedPaths: z.array(RelativeWorkspacePathSchema).max(100),
  fixedChecks: z.array(FixedCheckRefSchema).max(20).default([]),
  e2eSkillPath: E2EProjectSkillPathSchema.optional(),
  e2eRequiredEnvironment: z.array(E2EAuthenticationEnvironmentNameSchema).max(32).default([]),
  deadlineMs: z.number().int().min(1_000).max(30 * 60_000),
  traceContext: CodeTaskTraceContextSchema.default({}),
  inputPatchRef: ArtifactRefSchema.optional(),
  playwrightVerification: ChangedProjectPlaywrightVerificationSchema.optional(),
}).strict().superRefine((value, context) => {
  validateE2EAuthenticationEnvironment(value.e2eRequiredEnvironment, context, ["e2eRequiredEnvironment"]);
  if (["web-e2e-author", "web-e2e-repair"].includes(value.executionProfileId) && !value.e2eSkillPath) {
    context.addIssue({
      code: "custom",
      path: ["e2eSkillPath"],
      message: "E2E authoring requires a frozen repository-local project Skill",
    });
  }
  if (value.fixedChecks.some(check => check.id === "playwright") && !value.playwrightVerification) {
    context.addIssue({
      code: "custom",
      path: ["playwrightVerification"],
      message: "A frozen Playwright verification mapping is required for the playwright fixed check",
    });
  }
});
export type CodeTaskSpec = z.infer<typeof CodeTaskSpecSchema>;

export const CheckResultSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  exitCode: z.number().int(),
  summary: z.string(),
  durationMs: z.number().int().nonnegative(),
  artifacts: z.array(ArtifactRefSchema).default([]),
}).strict();
export type CheckResult = z.infer<typeof CheckResultSchema>;
export const CodeTaskChangeSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  mode: z.enum(["100644", "100755", "120000"]).optional(),
  contentRef: ArtifactRefSchema.optional(),
}).strict();
export type CodeTaskChange = z.infer<typeof CodeTaskChangeSchema>;
export const CodeTaskProvenanceSchema = z.object({
  imageDigest: z.string().min(1),
  profileHash: z.string().regex(/^[a-f0-9]{64}$/u),
  agentBackend: z.literal("native-mastra"),
  mastraVersion: z.string().min(1),
  model: z.string().min(1),
}).strict();
export const CodeTaskResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "cancelled", "lost"]),
  summary: z.string(),
  changedPaths: z.array(z.string()),
  changes: z.array(CodeTaskChangeSchema).default([]),
  patchRef: ArtifactRefSchema.optional(),
  checks: z.array(CheckResultSchema),
  artifacts: z.array(ArtifactRefSchema),
  provenance: CodeTaskProvenanceSchema,
}).strict();
export type CodeTaskResult = z.infer<typeof CodeTaskResultSchema>;

export const CodeTaskEventSchema = z.object({
  cursor: z.string().min(1),
  taskId: z.string().min(1),
  at: z.iso.datetime(),
  type: z.string().min(1),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type CodeTaskEvent = z.infer<typeof CodeTaskEventSchema>;
export const CodeTaskStateSchema = z.object({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  status: CodeTaskStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  result: CodeTaskResultSchema.optional(),
  error: z.string().optional(),
}).strict();
export type CodeTaskState = z.infer<typeof CodeTaskStateSchema>;
export const CodeTaskEventPageSchema = z.object({
  events: z.array(CodeTaskEventSchema),
  nextCursor: z.string().optional(),
}).strict();
export type CodeTaskEventPage = z.infer<typeof CodeTaskEventPageSchema>;

export const EvidenceManifestSchema = z.object({
  runId: z.string().min(1),
  commitSha: z.string().min(1),
  framework: E2EFrameworkSchema,
  frameworkVersion: z.string().min(1),
  environment: z.string().min(1),
  command: z.string().min(1),
  exitCode: z.number().int(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(),
  artifacts: z.array(ArtifactRefSchema),
  checksums: z.record(z.string(), z.string()),
});
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export const E2ERepositoryExecutionSchema = z.object({
  owner: z.string().min(1),
  repository: z.string().min(1),
  workspacePath: z.string().min(1),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
  allowedPaths: z.array(z.string().min(1)).min(1),
  skillPaths: z.array(z.string().min(1)).default([]),
  // Optional only while decoding execution briefs created before repository-
  // local E2E Skills became mandatory. New authoring rejects a missing value.
  e2eSkillPath: E2EProjectSkillPathSchema.optional(),
  e2eAuthentication: E2EAuthenticationSchema.optional(),
  installCommand: z.array(z.string()).optional(),
  testCommand: z.array(z.string()).optional(),
  specGlobs: z.array(z.string()).default([]),
  artifactGlobs: z.array(z.string()).default([]),
  testEnvironment: E2ETestEnvironmentSchema.optional(),
  verification: ChangedProjectPlaywrightVerificationSchema,
}).strict();
export type E2ERepositoryExecution = z.infer<typeof E2ERepositoryExecutionSchema>;

export const E2EExecutionBriefSchema = z.object({
  version: z.literal(1),
  context: E2EContextSnapshotSchema,
  cases: z.array(TestCaseSpecSchema).min(1),
  repository: E2ERepositoryExecutionSchema,
  createdAt: z.iso.datetime(),
  briefHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type E2EExecutionBrief = z.infer<typeof E2EExecutionBriefSchema>;

export const E2EAmendmentSchema = z.object({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  reviewerId: z.string().min(1),
  feedback: z.string().min(1).max(5_000),
  caseVersionId: z.string().uuid().optional(),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type E2EAmendment = z.infer<typeof E2EAmendmentSchema>;

export const E2ERunSchema = z.object({
  applicationId: z.string().min(1),
  tenantId: z.string().min(1),
  id: z.string().min(1),
  requestId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  changeSetId: z.string().uuid(),
  contextSnapshot: E2EContextSnapshotSchema,
  caseSnapshot: z.array(TestCaseSpecSchema).default([]),
  executionBrief: E2EExecutionBriefSchema.optional(),
  briefHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  repositoryExecution: E2ERepositoryExecutionSchema.optional(),
  // Optional only while decoding legacy persisted runs. Every newly-created
  // run receives a trusted server-owned snapshot and execution fails closed
  // if an old run reaches the CodeTask workflow without one.
  playwrightVerification: ChangedProjectPlaywrightVerificationSchema.optional(),
  traceId: z.string().optional(),
  amendments: z.array(E2EAmendmentSchema).default([]),
  codeTaskIds: z.array(z.string()).default([]),
  repository: RepositoryProfileSchema,
  // Optional only while decoding historical runs created before the test
  // environment address became part of the frozen run contract.
  testEnvironment: E2ETestEnvironmentSchema.optional(),
  platform: E2EPlatformSchema,
  framework: E2EFrameworkSchema,
  status: RunStatusSchema,
  revision: z.number().int().positive().default(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  branch: z.string().optional(),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  pullRequestUrl: z.url().optional(),
  error: z.string().optional(),
  artifacts: z.array(ArtifactRefSchema),
});
export type E2ERun = z.infer<typeof E2ERunSchema>;

const SubmittedRepositoryProfileSchema = RepositoryProfileSchema.omit({ installCommand: true }).strict();

export const CreateE2ERunSchema = z.object({
  requestId: z.string().optional(),
  sourceSessionId: z.string().min(1),
  changeSetId: z.string().uuid(),
  handoff: E2EContextDraftSchema,
  // Execution commands are server-owned and can never be submitted by a browser/API client.
  repository: SubmittedRepositoryProfileSchema,
  testEnvironment: E2ETestEnvironmentSchema,
  playwrightVerification: ChangedProjectPlaywrightVerificationSchema,
  platform: E2EPlatformSchema,
  framework: E2EFrameworkSchema,
}).strict();
export type CreateE2ERun = z.infer<typeof CreateE2ERunSchema>;
export const CreateE2ERunRequestSchema = CreateE2ERunSchema.omit({
  requestId: true,
  sourceSessionId: true,
  repository: true,
  testEnvironment: true,
  playwrightVerification: true,
}).strict();
export type CreateE2ERunRequest = z.infer<typeof CreateE2ERunRequestSchema>;

export const QaVerdictSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  reviewerId: z.string().min(1),
  caseVersionId: z.string().uuid().optional(),
  feedback: z.string().max(5000).optional(),
});
export type QaVerdict = z.infer<typeof QaVerdictSchema>;
export const QaVerdictInputSchema = QaVerdictSchema.omit({ reviewerId: true }).superRefine((value, context) => {
  if (value.verdict === "request_changes" && !value.feedback?.trim()) {
    context.addIssue({ code: "custom", path: ["feedback"], message: "Feedback is required when requesting changes" });
  }
});
export type QaVerdictInput = z.infer<typeof QaVerdictInputSchema>;

export const RunEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  at: z.iso.datetime(),
  type: z.string(),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEventSchema>;
