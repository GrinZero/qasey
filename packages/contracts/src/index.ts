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

export const E2ERunSchema = z.object({
  applicationId: z.string().min(1),
  tenantId: z.string().min(1),
  id: z.string().min(1),
  requestId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  sourceCaseIds: z.array(z.string()),
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

export const CreateE2ERunSchema = z.object({
  requestId: z.string().optional(),
  sourceSessionId: z.string().min(1),
  sourceCaseIds: z.array(z.string().min(1)).min(1),
  // Execution commands are server-owned and can never be submitted by a browser/API client.
  repository: SubmittedRepositoryProfileSchema,
  platform: E2EPlatformSchema,
  framework: E2EFrameworkSchema,
}).strict();
export type CreateE2ERun = z.infer<typeof CreateE2ERunSchema>;

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
