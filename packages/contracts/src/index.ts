import { z } from "zod";

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

export const RepositoryProfileSchema = z.object({
  owner: z.string().min(1),
  repository: z.string().min(1),
  cloneUrl: z.string().min(1),
  baseRef: z.string().min(1).default("main"),
  allowedPaths: z.array(z.string().min(1)).min(1),
  skillsPaths: z.array(z.string()).default([".agents/skills", ".claude/skills", "skills"]),
  installCommand: z.array(z.string()).optional(),
});
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;

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
  kind: z.enum(["message", "attachment", "document", "metersphere_case", "repository"]),
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
  deadlineMs: z.number().int().min(1_000).max(30 * 60_000),
  traceContext: CodeTaskTraceContextSchema.default({}),
  inputPatchRef: ArtifactRefSchema.optional(),
}).strict();
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
  installCommand: z.array(z.string()).optional(),
  testCommand: z.array(z.string()).optional(),
  specGlobs: z.array(z.string()).default([]),
  artifactGlobs: z.array(z.string()).default([]),
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
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type E2EAmendment = z.infer<typeof E2EAmendmentSchema>;

export const E2ERunSchema = z.object({
  applicationId: z.string().min(1),
  tenantId: z.string().min(1),
  id: z.string().min(1),
  requestId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  sourceCaseIds: z.array(z.string()),
  contextSnapshot: E2EContextSnapshotSchema,
  caseSnapshot: z.array(TestCaseSpecSchema).default([]),
  executionBrief: E2EExecutionBriefSchema.optional(),
  briefHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  repositoryExecution: E2ERepositoryExecutionSchema.optional(),
  traceId: z.string().optional(),
  amendments: z.array(E2EAmendmentSchema).default([]),
  codeTaskIds: z.array(z.string()).default([]),
  repository: RepositoryProfileSchema,
  platform: E2EPlatformSchema,
  framework: E2EFrameworkSchema,
  status: RunStatusSchema,
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

const MeterSphereCaseReferenceSchema = z.string().trim().refine(
  value => /^\d+$/u.test(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value),
  { message: "MeterSphere case reference must be a canonical UUID id or numeric num" },
).describe("MeterSphere canonical UUID id（推荐）或纯数字 num；禁止名称、module_id 和 URL。");

export const CreateE2ERunSchema = z.object({
  requestId: z.string().optional(),
  sourceSessionId: z.string().min(1),
  sourceCaseIds: z.array(MeterSphereCaseReferenceSchema).min(1),
  handoff: E2EContextDraftSchema,
  // Execution commands are server-owned and can never be submitted by a browser/API client.
  repository: SubmittedRepositoryProfileSchema,
  platform: E2EPlatformSchema,
  framework: E2EFrameworkSchema,
}).strict();
export type CreateE2ERun = z.infer<typeof CreateE2ERunSchema>;
export const CreateE2ERunRequestSchema = CreateE2ERunSchema.omit({ requestId: true, sourceSessionId: true, repository: true }).strict();
export type CreateE2ERunRequest = z.infer<typeof CreateE2ERunRequestSchema>;

export const QaVerdictSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  reviewerId: z.string().min(1),
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
