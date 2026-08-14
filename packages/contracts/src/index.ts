import { z } from "zod";

export const QaseyChannelSchema = z.enum(["slack", "jira", "api"]);
export type QaseyChannel = z.infer<typeof QaseyChannelSchema>;

export const TriggerSourceSchema = z.enum(["slack", "api", "web", "jira", "github", "metersphere", "ci", "schedule", "n8n"]);
export const TriggerIntentSchema = z.enum([
  "analyze_requirement", "generate_test_cases", "generate_e2e", "rerun_e2e",
  "submit_review_feedback", "approve_pr_ready", "cancel_run",
]);
export const TriggerEnvelopeSchema = z.object({
  schemaVersion: z.literal("1"),
  eventId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  source: TriggerSourceSchema,
  eventType: z.string().min(1),
  intent: TriggerIntentSchema,
  occurredAt: z.iso.datetime(),
  actor: z.object({ externalId: z.string().min(1), tenantId: z.string().optional() }),
  subject: z.object({
    type: z.enum(["requirement", "pull_request", "test_case", "run"]),
    externalId: z.string().optional(),
    url: z.url().optional(),
  }),
  conversation: z.object({ key: z.string().min(1) }).optional(),
  replyTo: z.object({
    channel: z.enum(["slack", "web", "github", "jira"]),
    target: z.record(z.string(), z.string()),
  }).optional(),
  rawPayloadRef: z.string().min(1),
  traceId: z.string().min(1),
});
export type TriggerEnvelope = z.infer<typeof TriggerEnvelopeSchema>;

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

export const QaIntentSchema = z.enum([
  "qa_quick_query",
  "qa_review",
  "case_create_full",
  "case_maintain_fast",
  "experience_read",
  "experience_write",
  "meta_or_out_of_scope",
  "unknown",
]);
export const E2EIntentSchema = z.enum([
  "e2e_generate",
  "e2e_rerun",
  "e2e_repair",
  "e2e_status",
]);
export const IntentSchema = z.union([QaIntentSchema, E2EIntentSchema]);
export type Intent = z.infer<typeof IntentSchema>;

export const IntentRouteSchema = z.object({
  version: z.literal(2).default(2),
  intent: IntentSchema,
  relation: z.enum(["new", "follow_up", "unknown"]),
  writeTarget: z.enum(["none", "metersphere", "qa_experience", "git"]),
  depth: z.enum(["quick", "standard", "deep"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
  routerStatus: z.enum(["ok", "fallback"]),
});
export type IntentRoute = z.infer<typeof IntentRouteSchema>;

export const ToolEffectSchema = z.enum(["read", "write", "delete", "message", "approval"]);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

export const ToolPolicySchema = z.object({
  effect: ToolEffectSchema,
  allowedChannels: z.array(QaseyChannelSchema),
  allowedIntents: z.array(IntentSchema),
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

export const OutboundMessageSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  channel: z.enum(["slack", "web", "github", "jira"]),
  target: z.record(z.string(), z.string()),
  messageType: z.enum(["progress", "result", "error", "approval"]),
  content: z.object({ text: z.string().min(1), runId: z.string().optional() }),
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;

export const E2ERunSchema = z.object({
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
  pullRequestUrl: z.url().optional(),
  error: z.string().optional(),
  artifacts: z.array(ArtifactRefSchema),
});
export type E2ERun = z.infer<typeof E2ERunSchema>;

export const CreateE2ERunSchema = z.object({
  requestId: z.string().optional(),
  sourceSessionId: z.string().min(1),
  sourceCaseIds: z.array(z.string().min(1)).min(1),
  repository: RepositoryProfileSchema,
  platform: E2EPlatformSchema,
  framework: E2EFrameworkSchema,
});
export type CreateE2ERun = z.infer<typeof CreateE2ERunSchema>;

export const QaVerdictSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  reviewerId: z.string().min(1),
  feedback: z.string().max(5000).optional(),
});
export type QaVerdict = z.infer<typeof QaVerdictSchema>;

export const RunEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  at: z.iso.datetime(),
  type: z.string(),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEventSchema>;
