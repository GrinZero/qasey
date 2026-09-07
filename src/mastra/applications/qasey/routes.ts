import { cancelReviewChangeSet } from "./review-cancellation.ts";
import { ConversationAddressSchema } from "../../../../packages/contracts/src/index.ts";
import { InvalidConversationRecipientError, publicSnapshot, sharedContext } from "../../../../packages/domain/src/collaboration-repository.ts";
import { collaborationRepository } from "../../runtime.ts";
import { acceptCollaborationMessage, attachConversationRuns } from "./collaboration.ts";
import { collaborationUIMessages } from "./collaboration-view.ts";
import { e2eTaskFromTurn, reviewPlanTasks } from "./e2e-task-links.ts";
import { conversationRunFromToolResult } from "./conversation-run-links.ts";
import { artifactContentDisposition } from "./artifact-headers.ts";
import { registerApiRoute } from "@mastra/core/server";
import { RequestContext } from "@mastra/core/request-context";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { ApproveCaseReviewItemsSchema, CaseHubResultReviewInputSchema, CaseReviewItemRevisionSchema, CaseReviewPlanPresentationSchema, GenerateE2EConversationActionSchema, UpdateCaseReviewItemSchema, type CaseHubChangeSet, type CaseHubResult, type CaseReviewPlanDetail, type CaseReviewPlanPresentation, type GenerateE2EConversationAction, type OwnerScope, type QaseyConversationEvent } from "../../../../packages/contracts/src/index.ts";
import { CaseReviewForbiddenError, CaseReviewRevisionConflictError, ConversationBusyError, ConversationTurnClosedError, normalizeJiraWebhook, projectCaseHubDetail } from "../../../../packages/domain/src/index.ts";
import { artifactStore, caseHubRepository, channelDeliveryInbox, config, conversationRepository, e2eFixtureLeaseService, e2ePreflight, githubClient, jiraClient, runRepository, sandboxPoolClient } from "../../runtime.ts";
import { ArtifactNotFoundError, ArtifactOwnershipError, ArtifactRangeNotSatisfiableError, parseArtifactByteRange, type ArtifactByteRange } from "../../../../packages/e2e/src/index.ts";
import { cancelE2ERun, dispatchE2ERepair, rerunE2E, resumeE2EWithVerdict } from "../../workflows/e2e-workflow.ts";
import { ownerScopeFromRequestContext } from "../../../platform/context/owner-scope.ts";
import type { OwnedApiRoute, PrimitiveAccessPolicy } from "../../../runtime/application.ts";
import { conversationScope } from "../../../platform/context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../../../platform/context/schema.ts";
import { OAuthPrincipalSchema } from "../../../platform/auth/oauth-principal.ts";
import type { PlatformBrowserUser } from "../../../platform/auth/google-oidc.ts";
import { executeQasey } from "./service.ts";
import { runtimeReadiness } from "../../../platform/storage/readiness.ts";
import { productionSignals } from "../../../platform/observability/production-signals.ts";
import { devRuntimeTunnelServerEnabled } from "../../../../packages/adapters/src/config.ts";
import { webE2EConfigurationFromSkill } from "../../../platform/code-task/e2e-repository-skill.ts";
import { resultEvidenceTimeline } from "./evidence-timeline.ts";
import { traceViewerContentType, traceViewerRelativePath, playwrightTraceViewerRoot } from "../../../platform/e2e/trace-viewer.ts";
import { conversationEventStreamResponse, conversationTurnsToUIMessages } from "./ui-message.ts";
import { publicToolCallPresentation, publicToolResultPresentation } from "./slack-progress.ts";
import {
  bearerToken,
  DEV_RUNTIME_HEARTBEAT_MS,
  DevRuntimeApprovalCallbackSchema,
  DevRuntimeClientEventSchema,
  DevRuntimeIdSchema,
  DevRuntimeInstanceIdSchema,
  secureTokenMatches,
} from "./dev-runtime-protocol.ts";
import { DevRuntimeTunnelError, getDevRuntimeTunnelService } from "./dev-runtime-service.ts";
import { slackTunnelApprovalDecisionCard } from "./slack-tunnel-delivery.ts";
import {
  SandboxBrowserActionSchema, SandboxBrowserStartSchema, SandboxDesktopActionSchema,
  SandboxDesktopApplicationSchema, SandboxDesktopStartSchema, SandboxDesktopToolSchema,
} from "../../../platform/workspace/sandbox-protocol.ts";

const QaseyTaskRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
}).strict();

const QaseyConversationMessageSchema = ConversationAddressSchema.extend({
  message: z.string().trim().min(1).max(100_000),
  clientMessageId: z.string().uuid(),
}).strict();

function authenticatedUser(c: { get(key: "requestContext"): { get(key: string): unknown } }): PlatformBrowserUser | undefined {
  return c.get("requestContext").get("user") as PlatformBrowserUser | undefined;
}

function owner(c: { get(key: "requestContext"): import("@mastra/core/request-context").RequestContext }) {
  return ownerScopeFromRequestContext(c.get("requestContext"));
}

function conversationSubject(c: { get(key: "requestContext"): import("@mastra/core/request-context").RequestContext }): string {
  return OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal")).subjectId;
}

function errorBody(error: unknown, requestId: string) {
  const message = config.NODE_ENV === "production"
    ? "The request could not be completed. Use the request ID to inspect server logs."
    : error instanceof Error ? error.message : String(error);
  return { message, requestId };
}

function reviewMutationError(error: unknown): { body: Record<string, unknown>; status: 403 | 409 } {
  if (error instanceof CaseReviewForbiddenError) return { body: { error: error.code, message: error.message }, status: 403 };
  if (error instanceof CaseReviewRevisionConflictError) return { body: { error: error.code, message: error.message }, status: 409 };
  return { body: { error: "case_review_failed", ...errorBody(error, crypto.randomUUID()) }, status: 409 };
}

async function decorateReviewPlan(ownerScope: OwnerScope, detail: CaseReviewPlanDetail): Promise<CaseReviewPlanPresentation> {
  const versionIds = detail.items.flatMap(item => item.publishedCaseVersionId ? [item.publishedCaseVersionId] : []);
  const caseIds = [...new Set(detail.items.flatMap(item => item.publishedCaseId ? [item.publishedCaseId] : []))];
  const cases = await Promise.all(caseIds.map(caseId => caseHubRepository.getCase(ownerScope, caseId)));
  const currentVersions = cases.flatMap(item => item?.activeVersionId ? [item.activeVersionId] : []);
  const [historicalStatuses, currentStatuses, versionsByCase] = await Promise.all([
    caseHubRepository.automationStatuses(ownerScope, versionIds),
    caseHubRepository.automationStatuses(ownerScope, currentVersions),
    Promise.all(caseIds.map(async caseId => [caseId, await caseHubRepository.versionsForCase(ownerScope, caseId)] as const)),
  ]);
  const currentByCase = new Map(cases.flatMap(item => item?.activeVersionId ? [[item.id, item.activeVersionId] as const] : []));
  const versionById = new Map(versionsByCase.flatMap(([, versions]) => versions.map(version => [version.id, version] as const)));
  return CaseReviewPlanPresentationSchema.parse({
    ...detail,
    ...(detail.editable ? { e2eTasks: await reviewPlanTasks(conversationRepository, ownerScope, detail.plan.subjectId, detail.plan.conversationId, detail.plan.id) } : {}),
    items: detail.items.map(item => {
      const automationStatus = item.publishedCaseVersionId ? historicalStatuses[item.publishedCaseVersionId] ?? "none" : "none";
      const currentCaseVersionId = item.publishedCaseId ? currentByCase.get(item.publishedCaseId) : undefined;
      const currentVersion = currentCaseVersionId ? versionById.get(currentCaseVersionId) : undefined;
      const currentAutomationStatus = currentCaseVersionId ? currentStatuses[currentCaseVersionId] ?? "none" : undefined;
      return {
        ...item,
        automationStatus,
        systemTags: automationStatus === "verified" ? ["e2e"] : [],
        ...(currentCaseVersionId ? {
          isCurrentCaseVersion: currentCaseVersionId === item.publishedCaseVersionId,
          currentCaseVersionId,
          currentCaseVersion: currentVersion?.version,
          currentAutomation: { status: currentAutomationStatus },
        } : {}),
      };
    }),
  });
}

function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

function runEventResponse(ownerScope: OwnerScope, runId: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        try { controller.close(); } catch { /* The client may have already disconnected. */ }
      };
      const poll = async () => {
        if (closed) return;
        try {
          const [run, events] = await Promise.all([
            runRepository.get(ownerScope, runId), runRepository.events(ownerScope, runId),
          ]);
          if (!run) { close(); return; }
          if (run.revision !== revision) {
            revision = run.revision;
            controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify({ run })}\n\n`));
          }
          for (const event of events) {
            if (seen.has(event.id)) continue;
            seen.add(event.id);
            controller.enqueue(encoder.encode(`id: ${event.id}\nevent: run.event\ndata: ${JSON.stringify({ event })}\n\n`));
          }
          if (["succeeded", "failed", "cancelled"].includes(run.status)) { close(); return; }
          timer = setTimeout(() => { void poll(); }, 500);
          timer.unref?.();
        } catch (error) {
          controller.error(error);
          close();
        }
      };
      signal.addEventListener("abort", close, { once: true });
      void poll();
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });
  return new Response(body, { headers: sseHeaders() });
}

export async function executeConversationTurn(input: {
  mastra: Parameters<typeof executeQasey>[0];
  principal: z.infer<typeof OAuthPrincipalSchema>;
  owner: OwnerScope;
  conversationId: string;
  turnId: string;
  message: string;
  action?: GenerateE2EConversationAction;
  agentId?: string;
  collaborationTools?: import("@mastra/core/agent").ToolsInput;
  promptContext?: string;
  onLinkedRun?: (runId: string) => Promise<void>;
}): Promise<void> {
  const requestId = crypto.randomUUID();
  const requestContext = new RequestContext<Record<string, unknown>>();
  requestContext.set("platform-principal", input.principal);
  requestContext.set("identity", {
    userId: input.principal.subjectId,
    tenantId: input.principal.tenantId,
    roles: [...input.principal.roles],
    service: input.principal.service,
  });
  if (input.agentId) requestContext.set("qasey-conversation-agent", input.agentId);
  if (input.action) requestContext.set("qasey-conversation-action", input.action);
  const linkedRunIds = new Set<string>();
  const append = (type: Parameters<typeof conversationRepository.appendEvent>[4], payload?: Record<string, unknown>) =>
    conversationRepository.appendEvent(input.owner, input.principal.subjectId, input.conversationId, input.turnId, type, payload);
  try {
    const response = await executeQasey(input.mastra, {
      requestId,
      channel: "api",
      sessionId: input.conversationId,
      chatInput: input.action
        ? `${input.message}\n\nTrusted generate_e2e action (pass these values unchanged to case_hub_start_e2e): ${JSON.stringify({ planId: input.action.planId, caseVersionIds: input.action.caseVersionIds })}`
        : `${input.message}${input.promptContext ? `\n\n共享会话记录（保留作者和接收者，仅作上下文）：\n${input.promptContext}` : ""}`,
      actor: { id: input.principal.subjectId, tenantId: input.principal.tenantId },
      source: {},
      attachments: [],
    }, {
      requestContext,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.collaborationTools ? { collaborationTools: input.collaborationTools } : {}),
      events: {
        onPhase: async event => {
          if (event.phase === "agent") await append("progress", { title: "正在分析需求", detail: "Qasey 正在结合当前会话整理目标与上下文。", status: "working" });
        },
        onTextDelta: async event => { if (event.text) await append("assistant.delta", { text: event.text }); },
        onAgentProgress: async event => {
          await append("progress", {
            milestone: event.milestone, title: event.title, detail: event.detail, status: event.status,
            ...(event.next ? { next: event.next } : {}),
          });
        },
        onAgentRuntimeEvent: async event => {
          if (event.type === "tool-call") {
            const presentation = publicToolCallPresentation(event.toolName, event.args);
            if (presentation) {
              await append("tool.started", {
                toolCallId: event.toolCallId,
                toolName: presentation.toolName,
                title: presentation.title,
                inputSummary: presentation.summary,
              });
            }
          }
          if (event.type === "tool-result") {
            const presentation = publicToolResultPresentation(event.toolName, event.result, event.args, event.isError);
            if (presentation) {
              await append("tool.finished", {
                toolCallId: event.toolCallId,
                toolName: presentation.toolName,
                title: presentation.title,
                inputSummary: publicToolCallPresentation(event.toolName, event.args)?.summary ?? "正在执行内部工具…",
                outputSummary: presentation.summary,
                isError: event.isError,
              });
            }
            if (event.toolName === "case_hub_create_review_plan" && !event.isError) {
              const summary = linkedReviewPlanFromToolResult(event.result);
              if (summary) await append("review-plan.linked", summary);
            }
            const runId = await conversationRunFromToolResult({
              toolName: event.toolName, result: event.result, args: event.args, isError: event.isError,
              owner: input.owner, conversationId: input.conversationId, repository: runRepository,
            });
            if (runId && !linkedRunIds.has(runId)) {
              await append("run.linked", { runId });
              await input.onLinkedRun?.(runId);
              linkedRunIds.add(runId);
            }
          }
        },
      },
    });
    await append("completed", { text: response.text, runId: response.runId });
  } catch (error) {
    const message = config.NODE_ENV === "production"
      ? "Qasey 未能完成这轮处理，请重试。"
      : error instanceof Error ? error.message : String(error);
    try {
      await append("failed", { message });
    } catch (appendError) {
      // A periodic recovery pass may have finalized an unresponsive turn while
      // its underlying tool or model call was still unwinding.
      if (!(appendError instanceof ConversationTurnClosedError)) throw appendError;
    }
  }
}

function linkedReviewPlanFromToolResult(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const detail = result as { plan?: unknown; items?: unknown };
  if (!detail.plan || typeof detail.plan !== "object" || !Array.isArray(detail.items)) return undefined;
  const plan = detail.plan as { id?: unknown; revision?: unknown; status?: unknown };
  if (typeof plan.id !== "string" || !z.uuid().safeParse(plan.id).success || typeof plan.revision !== "number") return undefined;
  const counts = detail.items.reduce((value, item) => {
    const status = item && typeof item === "object" ? (item as { status?: unknown }).status : undefined;
    if (status === "pending") value.pendingCount++;
    if (status === "approved") value.approvedCount++;
    if (status === "removed") value.removedCount++;
    return value;
  }, { pendingCount: 0, approvedCount: 0, removedCount: 0 });
  return { planId: plan.id, revision: plan.revision, status: plan.status, ...counts };
}

function sandboxScope(c: { get(key: "requestContext"): import("@mastra/core/request-context").RequestContext; req: { param(name: string): string } }) {
  const ownerScope = owner(c);
  return { ...ownerScope, sessionId: c.req.param("sessionId") };
}

function requireSandboxPool() {
  if (!sandboxPoolClient) throw new Error("Qasey sandbox pool is not configured");
  return sandboxPoolClient;
}

function allLatestResultsApproved(results: CaseHubResult[]): boolean {
  if (results.length === 0) return false;
  const latest = new Map<string, CaseHubResult>();
  for (const result of results) {
    const current = latest.get(result.caseVersionId);
    if (!current || result.attempt > current.attempt) latest.set(result.caseVersionId, result);
  }
  return [...latest.values()].every(result => result.executionStatus === "passed" && result.reviewStatus === "approved");
}

function validGitHubSignature(rawBody: string, signature: string | undefined): boolean {
  if (!config.GITHUB_WEBHOOK_SECRET || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", config.GITHUB_WEBHOOK_SECRET).update(rawBody).digest("hex")}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function tunnelAuthorized(authorization: string | undefined): boolean {
  return devRuntimeTunnelServerEnabled(config)
    && secureTokenMatches(bearerToken(authorization), config.QASEY_DEV_TUNNEL_TOKEN);
}

function tunnelErrorResponse(c: { json: (body: unknown, status?: any) => Response }, error: unknown) {
  if (error instanceof DevRuntimeTunnelError) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  if (error instanceof z.ZodError) return c.json({ error: "validation_error", details: error.issues }, 400);
  return c.json({ error: "dev_runtime_tunnel_failed", message: "The development runtime tunnel request failed" }, 500);
}

export const apiRoutes = [
  registerApiRoute("/healthz", { method: "GET", requiresAuth: false, handler: async c => c.json({ status: "ok", service: "qasey" }) }),
  registerApiRoute("/readyz", {
    method: "GET",
    requiresAuth: false,
    handler: async c => {
      const snapshot = await runtimeReadiness.inspect();
      return c.json({
        status: snapshot.ready ? "ready" : "not_ready",
        storage: config.DATABASE_URL ? "postgres" : "memory",
        dependencies: snapshot.dependencies,
      }, snapshot.ready ? 200 : 503);
    },
  }),
  registerApiRoute("/internal/metrics", {
    method: "GET",
    handler: async () => {
      const [readiness, sandbox] = await Promise.all([
        runtimeReadiness.inspect(),
        sandboxPoolClient?.capacity(),
      ]);
      const body = productionSignals.render({
        instanceId: config.QASEY_INSTANCE_ID ?? "unassigned",
        version: config.DD_VERSION ?? "unversioned",
        role: config.MASTRA_WORKERS === "orchestration" ? "worker" : "api",
        deploymentMode: config.QASEY_DEPLOYMENT_MODE,
        readiness,
        modelCostReportingConfigured: config.QASEY_MODEL_INPUT_COST_MICROUSD_PER_TOKEN !== undefined
          && config.QASEY_MODEL_OUTPUT_COST_MICROUSD_PER_TOKEN !== undefined,
        ...(sandbox ? { sandbox } : {}),
      });
      return new Response(body, {
        headers: {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    },
  }),
  registerApiRoute("/internal/e2e/version", {
    method: "GET",
    handler: async c => c.json(e2eFixtureLeaseService.version()),
  }),
  registerApiRoute("/internal/e2e/leases", {
    method: "POST",
    handler: async c => {
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const input = z.object({ ttlSeconds: z.number().int().min(60).max(14_400).default(3_600) }).strict().parse(await c.req.json().catch(() => ({})));
      return c.json(await e2eFixtureLeaseService.create(principal.subjectId, input.ttlSeconds), 201);
    },
  }),
  registerApiRoute("/internal/e2e/leases/:leaseId", {
    method: "DELETE",
    handler: async c => {
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const result = await e2eFixtureLeaseService.deleteForOwner(principal.subjectId, c.req.param("leaseId"));
      if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
      return c.json({ deleted: true });
    },
  }),
  registerApiRoute("/v1/dev-runtimes/events", {
    method: "GET",
    requiresAuth: false,
    handler: async c => {
      if (!devRuntimeTunnelServerEnabled(config)) return c.json({ error: "not_found" }, 404);
      if (!tunnelAuthorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
      try {
        const runtimeId = DevRuntimeIdSchema.parse(c.req.query("runtimeId"));
        const instanceId = DevRuntimeInstanceIdSchema.parse(c.req.query("instanceId"));
        const encoder = new TextEncoder();
        let closeConnection: (() => Promise<void>) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let closed = false;
        const close = async () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          await closeConnection?.();
        };
        const body = new ReadableStream<Uint8Array>({
          start: async controller => {
            try {
              closeConnection = await getDevRuntimeTunnelService(c.get("mastra")).openConnection({
                runtimeId,
                instanceId,
                send: async event => {
                  if (!closed) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
                },
              });
              heartbeat = setInterval(() => {
                if (!closed) controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
              }, DEV_RUNTIME_HEARTBEAT_MS);
              heartbeat.unref?.();
              c.req.raw.signal.addEventListener("abort", () => { void close(); }, { once: true });
            } catch (error) {
              controller.error(error);
              await close();
            }
          },
          cancel: close,
        });
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      } catch (error) {
        return tunnelErrorResponse(c, error);
      }
    },
  }),
  registerApiRoute("/v1/dev-runtimes/:runtimeId/jobs/:jobId/events", {
    method: "POST",
    requiresAuth: false,
    handler: async c => {
      if (!devRuntimeTunnelServerEnabled(config)) return c.json({ error: "not_found" }, 404);
      if (!tunnelAuthorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
      try {
        const runtimeId = DevRuntimeIdSchema.parse(c.req.param("runtimeId"));
        const instanceId = DevRuntimeInstanceIdSchema.parse(c.req.header("x-qasey-runtime-instance"));
        const event = DevRuntimeClientEventSchema.parse(await c.req.json());
        await getDevRuntimeTunnelService(c.get("mastra")).publishClientEvent({
          runtimeId,
          instanceId,
          jobId: c.req.param("jobId"),
          event,
        });
        return c.json({ accepted: true }, 202);
      } catch (error) {
        return tunnelErrorResponse(c, error);
      }
    },
  }),
  registerApiRoute("/v1/dev-runtime-approvals/:approvalId", {
    method: "POST",
    requiresAuth: false,
    handler: async c => {
      if (!devRuntimeTunnelServerEnabled(config)) return c.json({ error: "not_found" }, 404);
      try {
        const callback = DevRuntimeApprovalCallbackSchema.parse(await c.req.json());
        const decision = callback.actionId === "qasey_local_approve" ? "approved" : "declined";
        const record = await getDevRuntimeTunnelService(c.get("mastra")).decideApproval({
          approvalId: c.req.param("approvalId"),
          token: c.req.query("token") ?? "",
          slackUserId: callback.user.id,
          decision,
        });
        if (record.threadId && record.messageId) {
          const sdk = c.get("mastra").getAgent("qasey-main").getChannels()?.sdk;
          const thread = sdk?.thread(record.threadId);
          if (thread) await thread.adapter.editMessage(
            thread.id,
            record.messageId,
            slackTunnelApprovalDecisionCard(record, decision, callback.user.name),
          );
        }
        return c.json({ accepted: true, decision });
      } catch (error) {
        return tunnelErrorResponse(c, error);
      }
    },
  }),
  registerApiRoute("/webhooks/jira", {
    method: "POST",
    requiresAuth: false,
    handler: async c => {
      const requestId = crypto.randomUUID();
      try {
        const body = await c.req.json();
        const context = normalizeJiraWebhook(body, config.JIRA_QASEY_ACCOUNT_ID);
        if (!context) return c.json({ accepted: false, reason: "ignored" }, 202);
        const ownerScope = owner(c);
        const accepted = await channelDeliveryInbox.accept(ownerScope, context.requestId);
        if (!accepted) return c.json({ accepted: false, duplicate: true }, 202);
        const issueKey = context.source.issueKey;
        if (!issueKey) return c.json({ accepted: false, reason: "missing_issue" }, 202);
        const requestContext = c.get("requestContext");
        const identity = requestContext.get("identity") as { userId: string };
        const scope = conversationScope({
          applicationId: ownerScope.applicationId,
          tenantId: ownerScope.tenantId,
          userId: identity.userId,
          conversationId: issueKey,
          externalThreadId: issueKey,
          kind: "shared",
        });
        requestContext.set("requestId", context.requestId);
        requestContext.set("sessionId", scope.threadId);
        requestContext.set(MASTRA_RESOURCE_ID_KEY, scope.resourceId);
        requestContext.set(MASTRA_THREAD_ID_KEY, scope.threadId);
        const result = await executeQasey(c.get("mastra"), {
          ...context,
          actor: {
            id: identity.userId,
            ...(context.actor.displayName ? { displayName: context.actor.displayName } : {}),
            tenantId: ownerScope.tenantId,
          },
        }, { requestContext });
        await jiraClient.addComment(issueKey, result.text);
        return c.json({ accepted: true, duplicate: false }, 200);
      } catch (error) {
        return c.json({ error: "upstream_error", ...errorBody(error, requestId) }, 502);
      }
    },
  }),
  registerApiRoute("/webhooks/github", {
    method: "POST",
    requiresAuth: false,
    handler: async c => {
      const rawBody = await c.req.text();
      if (!validGitHubSignature(rawBody, c.req.header("x-hub-signature-256"))) return c.json({ error: "invalid_signature" }, 401);
      const deliveryId = c.req.header("x-github-delivery");
      if (!deliveryId) return c.json({ error: "missing_delivery_id" }, 400);
      const ownerScope = owner(c);
      if (!await channelDeliveryInbox.accept(ownerScope, `github:${deliveryId}`)) return c.json({ accepted: false, duplicate: true }, 202);
      if (c.req.header("x-github-event") !== "pull_request") return c.json({ accepted: false, reason: "ignored" }, 202);
      const payload = z.object({
        action: z.string(),
        pull_request: z.object({ html_url: z.url(), merged: z.boolean() }),
      }).passthrough().parse(JSON.parse(rawBody));
      if (payload.action !== "closed") return c.json({ accepted: false, reason: "ignored" }, 202);
      const changeSet = (await caseHubRepository.listChangeSets(ownerScope, 500))
        .find(candidate => candidate.pullRequestUrl === payload.pull_request.html_url);
      if (!changeSet) return c.json({ accepted: false, reason: "unknown_pull_request" }, 202);
      await settleClosedPullRequest(ownerScope, changeSet, payload.pull_request.merged);
      return c.json({ accepted: true });
    },
  }),
  registerApiRoute("/internal/case-hub/change-sets/:changeSetId/reconcile", {
    method: "POST",
    handler: async c => {
      const ownerScope = owner(c);
      const changeSet = await caseHubRepository.getChangeSet(ownerScope, c.req.param("changeSetId"));
      if (!changeSet) return c.json({ error: "not_found" }, 404);
      if (!changeSet.pullRequestUrl) return c.json({ reconciled: false, reason: "no_pull_request" });
      const pullRequest = parseGitHubPullRequestUrl(changeSet.pullRequestUrl);
      if (!pullRequest || pullRequest.owner !== changeSet.repository.owner || pullRequest.repository !== changeSet.repository.repository) {
        return c.json({ error: "invalid_pull_request_url" }, 409);
      }
      if (!githubClient) return c.json({ error: "github_not_configured" }, 503);
      try {
        const response = await githubClient.pulls.get({ owner: pullRequest.owner, repo: pullRequest.repository, pull_number: pullRequest.number });
        if (response.data.state !== "closed") return c.json({ reconciled: false, state: response.data.state });
        await settleClosedPullRequest(ownerScope, changeSet, Boolean(response.data.merged));
        return c.json({ reconciled: true, state: response.data.merged ? "merged" : "abandoned" });
      } catch (error) {
        return c.json({ error: "pull_request_reconcile_failed", ...errorBody(error, crypto.randomUUID()) }, 409);
      }
    },
  }),
  registerApiRoute("/v1/qasey/conversations", {
    method: "GET",
    handler: async c => c.json({
      conversations: await conversationRepository.listConversations(
        owner(c), conversationSubject(c), Number(c.req.query("limit") ?? 50),
      ),
    }),
  }),
  registerApiRoute("/v1/qasey/conversations", {
    method: "POST",
    handler: async c => c.json({
      conversation: await conversationRepository.createConversation(owner(c), conversationSubject(c)),
    }, 201),
  }),
  registerApiRoute("/v1/qasey/conversations/:conversationId", {
    method: "GET",
    handler: async c => {
      const ownerScope = owner(c);
      const subjectId = conversationSubject(c);
      const conversation = await conversationRepository.getConversation(ownerScope, subjectId, c.req.param("conversationId"));
      if (!conversation) return c.json({ error: "not_found" }, 404);
      const turns = await conversationRepository.listTurns(ownerScope, subjectId, conversation.id);
      const eventGroups = await Promise.all(turns.map(async turn => [
        turn.id,
        await conversationRepository.events(ownerScope, subjectId, conversation.id, turn.id),
      ] as const));
      const scope = { ...ownerScope, subjectId, conversationId: conversation.id };
      await attachConversationRuns(scope);
      const state = await collaborationRepository.read(scope);
      return c.json({ conversation, ...publicSnapshot(state), messages: collaborationUIMessages(state, turns, new Map(eventGroups), scope.conversationId) });
    },
  }),
  registerApiRoute("/v1/qasey/conversations/:conversationId/events", {
    method: "GET",
    handler: async c => {
      const scope = { ...owner(c), subjectId: conversationSubject(c), conversationId: c.req.param("conversationId") };
      if (!await conversationRepository.getConversation(scope, scope.subjectId, scope.conversationId)) return c.json({ error: "not_found" }, 404);
      await attachConversationRuns(scope);
      const encoder = new TextEncoder();
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cursor = Number(c.req.query("after") ?? 0);
      let lastSignature = "";
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const close = () => { if (closed) return; closed = true; if (timer) clearTimeout(timer); try { controller.close(); } catch {} };
          c.req.raw.signal.addEventListener("abort", close, { once: true });
          const poll = async () => {
            if (closed) return;
            try {
              const state = await collaborationRepository.read(scope);
              const turns = await conversationRepository.listTurns(scope, scope.subjectId, scope.conversationId);
              const signature = JSON.stringify([state.revision, turns.map(t => [t.id, t.updatedAt, t.assistantText.length])]);
              if (signature !== lastSignature) {
                const eventGroups = await Promise.all(turns.map(async t => [t.id, await conversationRepository.events(scope, scope.subjectId, scope.conversationId, t.id)] as const));
                // Snapshots replace state, so replay safely covers both missed revisions and legacy turns.
                cursor = state.revision;
                const data = { ...publicSnapshot(state), messages: collaborationUIMessages(state, turns, new Map(eventGroups), scope.conversationId) };
                controller.enqueue(encoder.encode(`id: ${cursor}\nevent: snapshot\ndata: ${JSON.stringify(data)}\n\n`));
                lastSignature = signature;
              } else controller.enqueue(encoder.encode(": heartbeat\n\n"));
              timer = setTimeout(() => { void poll(); }, 750);
              timer.unref?.();
            } catch { close(); }
          };
          void poll();
        },
        cancel() { closed = true; if (timer) clearTimeout(timer); },
      });
      return new Response(body, { headers: sseHeaders() });
    },
  }),
  registerApiRoute("/v1/qasey/conversations/:conversationId/messages", {
    method: "POST",
    handler: async c => {
      const parsed = QaseyConversationMessageSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      const ownerScope = owner(c);
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      try {
        if (parsed.data.recipientAgentIds || c.req.header("accept")?.includes("application/json")) {
          const scope = { ...ownerScope, subjectId: principal.subjectId, conversationId: c.req.param("conversationId") };
          const deliveryIds = await acceptCollaborationMessage(scope, {
            id: parsed.data.clientMessageId, text: parsed.data.message, principal,
            ...(parsed.data.recipientAgentIds ? { recipients: parsed.data.recipientAgentIds } : {}),
            ...(parsed.data.targetRunId ? { runId: parsed.data.targetRunId } : {}),
          });
          return c.json({ accepted: true, deliveryIds }, 202);
        }
        const started = await conversationRepository.startTurn(
          ownerScope, principal.subjectId, c.req.param("conversationId"),
          parsed.data.clientMessageId, parsed.data.message,
        );
        if (started.created) {
          void executeConversationTurn({
            mastra: c.get("mastra"), principal, owner: ownerScope,
            conversationId: started.turn.conversationId, turnId: started.turn.id, message: started.turn.userMessage,
          });
        }
        return conversationEventStreamResponse({
          repository: conversationRepository,
          owner: ownerScope, subjectId: principal.subjectId,
          conversationId: started.turn.conversationId, turn: started.turn,
          signal: c.req.raw.signal,
        });
      } catch (error) {
        if (error instanceof InvalidConversationRecipientError) return c.json({ error: error.code, message: error.message }, 400);
        if (error instanceof Error && error.message.includes("not found")) return c.json({ error: "not_found" }, 404);
        return c.json({ error: "conversation_turn_failed", ...errorBody(error, crypto.randomUUID()) }, 500);
      }
    },
  }),
  registerApiRoute("/v1/qasey/conversations/:conversationId/actions", {
    method: "POST",
    handler: async c => {
      const parsed = GenerateE2EConversationActionSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      const ownerScope = owner(c);
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const conversationId = c.req.param("conversationId");
      try {
        const conversation = await conversationRepository.getConversation(ownerScope, principal.subjectId, conversationId);
        if (!conversation) return c.json({ error: "not_found" }, 404);
        const detail = await caseHubRepository.getReviewPlan(ownerScope, parsed.data.planId, principal.subjectId);
        if (!detail || detail.plan.conversationId !== conversationId) return c.json({ error: "not_found" }, 404);
        if (!detail.editable) return c.json({ error: "case_review_forbidden" }, 403);
        if (parsed.data.caseVersionIds.length > 1 && detail.plan.status !== "ready") {
          return c.json({ error: "case_review_incomplete", message: "批量生成必须等待其余文字用例全部审核完成。" }, 409);
        }
        const approved = new Map(detail.items.filter(item => item.status === "approved" && item.publishedCaseVersionId)
          .map(item => [item.publishedCaseVersionId!, item.publishedCaseId!]));
        if (new Set(parsed.data.caseVersionIds).size !== parsed.data.caseVersionIds.length || parsed.data.caseVersionIds.some(id => !approved.has(id))) {
          return c.json({ error: "invalid_case_versions", message: "只能生成本计划中已批准的精确文字用例版本。" }, 409);
        }
        const selectedCases = await Promise.all(parsed.data.caseVersionIds.map(async caseVersionId => {
          const caseId = approved.get(caseVersionId)!;
          return { caseId, caseVersionId, caseRecord: await caseHubRepository.getCase(ownerScope, caseId) };
        }));
        const superseded = selectedCases.filter(item => item.caseRecord?.activeVersionId !== item.caseVersionId);
        if (superseded.length) {
          const current = await Promise.all(superseded.map(async item => {
            const version = item.caseRecord?.activeVersionId
              ? (await caseHubRepository.versionsForCase(ownerScope, item.caseId)).find(candidate => candidate.id === item.caseRecord?.activeVersionId)
              : undefined;
            return `${item.caseId} 已更新为 ${version ? `v${version.version}` : "当前版本"}`;
          }));
          return c.json({
            error: "superseded_case_versions",
            message: `所选版本属于历史审核记录，不能重复生成 E2E。${current.join("；")}。请从当前版本启动自动化。`,
          }, 409);
        }
        const message = `为已批准的文字用例 ${parsed.data.caseVersionIds.map(id => approved.get(id)).join("、")} 生成 E2E 自动化。`;
        const cases = await Promise.all(parsed.data.caseVersionIds.map(async caseVersionId => {
          const caseId = approved.get(caseVersionId)!;
          const versions = await caseHubRepository.versionsForCase(ownerScope, caseId);
          const version = versions.find(candidate => candidate.id === caseVersionId);
          if (!version) throw new Error("文字用例版本不存在，请刷新后重试。");
          return { caseId, caseVersionId, version: version.version, title: version.title };
        }));
        const started = await conversationRepository.startTurn(ownerScope, principal.subjectId, conversationId, parsed.data.clientMessageId, message, { planId: parsed.data.planId, cases });
        if (started.created) {
          const scope = { ...ownerScope, subjectId: principal.subjectId, conversationId };
          await collaborationRepository.send(scope, { id: started.turn.clientMessageId, text: message, principal,
            action: parsed.data, turnId: started.turn.id, context: sharedContext(await collaborationRepository.read(scope)) });
        }
        if (c.req.header("accept")?.includes("application/json")) {
          const task = e2eTaskFromTurn(started);
          if (!task) return c.json({ error: "missing_task_context", message: "该请求没有关联 E2E 任务，请返回原会话确认。" }, 409);
          return c.json(task, started.created ? 202 : 200);
        }
        return conversationEventStreamResponse({
          repository: conversationRepository, owner: ownerScope, subjectId: principal.subjectId,
          conversationId, turn: started.turn, signal: c.req.raw.signal,
        });
      } catch (error) {
        if (error instanceof ConversationBusyError) return c.json({ error: error.code, message: "当前会话仍在处理中，请等待完成后再继续。" }, 409);
        return c.json({ error: "conversation_action_failed", ...errorBody(error, crypto.randomUUID()) }, 409);
      }
    },
  }),
  registerApiRoute("/v1/qasey/conversations/:conversationId/turns/:turnId/events", {
    method: "GET",
    handler: async c => {
      const ownerScope = owner(c);
      const subjectId = conversationSubject(c);
      const conversationId = c.req.param("conversationId");
      const turnId = c.req.param("turnId");
      const turns = await conversationRepository.listTurns(ownerScope, subjectId, conversationId);
      if (!turns.some(turn => turn.id === turnId)) return c.json({ error: "not_found" }, 404);
      const headerSequence = Number(c.req.header("last-event-id") ?? 0);
      const queryValue = c.req.query("after");
      const querySequence = Number(queryValue);
      const after = queryValue !== undefined && Number.isFinite(querySequence) && querySequence >= 0
        ? querySequence
        : Number.isFinite(headerSequence) && headerSequence >= 0 ? headerSequence : 0;
      const turn = turns.find(item => item.id === turnId);
      if (!turn) return c.json({ error: "not_found" }, 404);
      return conversationEventStreamResponse({
        repository: conversationRepository,
        owner: ownerScope, subjectId, conversationId, turn,
        after,
        signal: c.req.raw.signal,
      });
    },
  }),
  registerApiRoute("/v1/qasey/tasks", {
    method: "POST",
    handler: async c => {
      const parsed = QaseyTaskRequestSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      const requestId = crypto.randomUUID();
      try {
        const requestContext = c.get("requestContext");
        const identity = requestContext.get("identity") as { userId: string; tenantId: string };
        const context = {
          requestId,
          channel: "api" as const,
          // This endpoint represents one task, not a long-lived chat. Use the
          // request id as its conversation id so repeated API calls cannot
          // inherit messages from a previous task by the same user.
          sessionId: requestId,
          chatInput: parsed.data.prompt,
          actor: { id: identity.userId, tenantId: identity.tenantId },
          source: {},
          attachments: [],
        };
        return c.json(await executeQasey(c.get("mastra"), context, { requestContext }));
      } catch (error) {
        return c.json({ error: "qasey_task_failed", ...errorBody(error, requestId) }, 502);
      }
    },
  }),
  registerApiRoute("/v1/case-hub/runs", {
    method: "GET",
    handler: async c => c.json({ runs: await runRepository.list(owner(c), Number(c.req.query("limit") ?? 100)) }),
  }),
  registerApiRoute("/v1/case-hub/review-plans", {
    method: "GET",
    handler: async c => {
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const ownerScope = owner(c);
      const plans = await caseHubRepository.listReviewPlans(ownerScope, principal.subjectId, Number(c.req.query("limit") ?? 100));
      return c.json({ plans: await Promise.all(plans.map(plan => decorateReviewPlan(ownerScope, plan))) });
    },
  }),
  registerApiRoute("/v1/case-hub/review-plans/:planId", {
    method: "GET",
    handler: async c => {
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const detail = await caseHubRepository.getReviewPlan(owner(c), c.req.param("planId"), principal.subjectId);
      return detail ? c.json(await decorateReviewPlan(owner(c), detail)) : c.json({ error: "not_found" }, 404);
    },
  }),
  registerApiRoute("/v1/case-hub/review-plans/:planId/cancel", {
    method: "POST",
    handler: async c => {
      const parsed = CaseReviewItemRevisionSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error" }, 400);
      const subjectId = conversationSubject(c);
      const scope = owner(c);
      const detail = await caseHubRepository.getReviewPlan(scope, c.req.param("planId"), subjectId);
      if (!detail) return c.json({ error: "not_found" }, 404);
      if (detail.plan.subjectId !== subjectId || detail.plan.createdBy !== subjectId) return c.json({ error: "case_review_forbidden" }, 403);
      const tasks = await reviewPlanTasks(conversationRepository, scope, subjectId, detail.plan.conversationId, detail.plan.id);
      if (tasks.some(task => task.status === "running")) return c.json({ error: "review_plan_running", message: "Agent 仍在处理中，请在原会话停止执行后再结束审核。" }, 409);
      try {
        return c.json(await caseHubRepository.cancelReviewPlan(scope, detail.plan.id, subjectId, parsed.data.expectedRevision));
      } catch (error) { const failure = reviewMutationError(error); return c.json(failure.body, failure.status); }
    },
  }),
  registerApiRoute("/v1/case-hub/review-plans/:planId/items/:itemId", {
    method: "PATCH",
    handler: async c => {
      const parsed = UpdateCaseReviewItemSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      try {
        return c.json(await caseHubRepository.updateReviewItem(owner(c), c.req.param("planId"), c.req.param("itemId"), principal.subjectId, parsed.data.expectedRevision, parsed.data.content));
      } catch (error) { const failure = reviewMutationError(error); return c.json(failure.body, failure.status); }
    },
  }),
  ...(["remove", "restore"] as const).map(action => registerApiRoute(`/v1/case-hub/review-plans/:planId/items/:itemId/${action}`, {
    method: "POST",
    handler: async c => {
      const parsed = CaseReviewItemRevisionSchema.pick({ expectedRevision: true }).safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      try {
        return c.json(await caseHubRepository.setReviewItemRemoved(owner(c), c.req.param("planId"), c.req.param("itemId"), principal.subjectId, parsed.data.expectedRevision, action === "remove"));
      } catch (error) { const failure = reviewMutationError(error); return c.json(failure.body, failure.status); }
    },
  })),
  registerApiRoute("/v1/case-hub/review-plans/:planId/items/:itemId/approve", {
    method: "POST",
    handler: async c => {
      const parsed = CaseReviewItemRevisionSchema.pick({ expectedRevision: true }).safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      try {
        return c.json(await caseHubRepository.approveReviewItems(owner(c), c.req.param("planId"), principal.subjectId, [{ itemId: c.req.param("itemId"), expectedRevision: parsed.data.expectedRevision }]));
      } catch (error) { const failure = reviewMutationError(error); return c.json(failure.body, failure.status); }
    },
  }),
  registerApiRoute("/v1/case-hub/review-plans/:planId/approve", {
    method: "POST",
    handler: async c => {
      const parsed = ApproveCaseReviewItemsSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      try {
        return c.json(await caseHubRepository.approveReviewItems(owner(c), c.req.param("planId"), principal.subjectId, parsed.data.items));
      } catch (error) { const failure = reviewMutationError(error); return c.json(failure.body, failure.status); }
    },
  }),
  registerApiRoute("/v1/case-hub/cases", {
    method: "GET",
    handler: async c => c.json({ cases: await caseHubRepository.listCases(owner(c), c.req.query("q") ?? "") }),
  }),
  registerApiRoute("/v1/case-hub/cases/:caseId", {
    method: "DELETE",
    handler: async c => {
      const deleted = await caseHubRepository.deleteCase(owner(c), c.req.param("caseId"));
      return deleted ? c.json({ deleted: true }) : c.json({ error: "not_found" }, 404);
    },
  }),
  registerApiRoute("/v1/case-hub/cases/:caseId", {
    method: "GET",
    handler: async c => {
      const caseRecord = await caseHubRepository.getCase(owner(c), c.req.param("caseId"));
      if (!caseRecord?.activeVersionId) return c.json({ error: "not_found" }, 404);
      const versions = await caseHubRepository.versionsForCase(owner(c), caseRecord.id);
      const versionIds = new Set(versions.map(version => version.id));
      const changeSets = (await caseHubRepository.listChangeSets(owner(c), 500))
        .filter(changeSet => changeSet.caseVersionIds.some(versionId => versionIds.has(versionId)));
      const results = (await Promise.all(changeSets.map(changeSet => caseHubRepository.listResults(owner(c), changeSet.id)))).flat();
      return c.json(projectCaseHubDetail(caseRecord, versions, changeSets, results));
    },
  }),
  registerApiRoute("/v1/case-hub/change-sets", {
    method: "GET",
    handler: async c => c.json({ changeSets: await caseHubRepository.listChangeSets(owner(c), Number(c.req.query("limit") ?? 100)) }),
  }),
  registerApiRoute("/v1/case-hub/preflight", {
    method: "GET",
    handler: async c => {
      const snapshot = await e2ePreflight.inspect(owner(c), webE2EConfigurationFromSkill());
      return c.json(snapshot, snapshot.ready ? 200 : 503);
    },
  }),
  registerApiRoute("/v1/case-hub/change-sets", {
    method: "POST",
    handler: async c => c.json({
      error: "text_case_review_required",
      message: "先在当前 AI session 创建并批准文字用例 Review Plan，再通过 conversation action 生成 E2E。",
    }, 409),
  }),
  registerApiRoute("/v1/case-hub/change-sets/:changeSetId/cancel", {
    method: "POST",
    handler: async c => {
      try {
        const changeSet = await cancelReviewChangeSet(caseHubRepository, runRepository, owner(c), c.req.param("changeSetId"),
          runId => cancelE2ERun(c.get("mastra"), owner(c), runId));
        return changeSet ? c.json(changeSet) : c.json({ error: "not_found" }, 404);
      } catch (error) { return c.json({ error: "cancel_verification_failed", ...errorBody(error, crypto.randomUUID()) }, 409); }
    },
  }),
  registerApiRoute("/v1/case-hub/change-sets/:changeSetId", {
    method: "GET",
    handler: async c => {
      const changeSet = await caseHubRepository.getChangeSet(owner(c), c.req.param("changeSetId"));
      if (!changeSet) return c.json({ error: "not_found" }, 404);
      const [versions, results] = await Promise.all([
        caseHubRepository.versionsForChangeSet(owner(c), changeSet.id),
        caseHubRepository.listResults(owner(c), changeSet.id),
      ]);
      return c.json({ changeSet, versions, results });
    },
  }),
  registerApiRoute("/v1/case-hub/results/:resultId/evidence-timeline", {
    method: "GET",
    handler: async c => {
      const timeline = await resultEvidenceTimeline(caseHubRepository, artifactStore, owner(c), c.req.param("resultId"));
      c.header("cache-control", "private, no-store");
      return timeline ? c.json(timeline) : c.json({ error: "not_found" }, 404);
    },
  }),
  registerApiRoute("/v1/case-hub/results/:resultId/review", {
    method: "POST",
    handler: async c => {
      const input = CaseHubResultReviewInputSchema.safeParse(await c.req.json());
      if (!input.success) return c.json({ error: "validation_error", details: input.error.issues }, 400);
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      try {
        const beforeReview = await caseHubRepository.getResult(owner(c), c.req.param("resultId"));
        if (!beforeReview) return c.json({ error: "not_found" }, 404);
        const reviewed = await caseHubRepository.reviewResult(owner(c), c.req.param("resultId"), principal.subjectId, input.data);
        const changeSet = await caseHubRepository.getChangeSet(owner(c), reviewed.changeSetId);
        if (!changeSet) return c.json({ error: "not_found" }, 404);
        if (beforeReview.reviewStatus !== "pending") {
          return c.json({ result: reviewed, changeSet }, input.data.verdict === "request_changes" ? 202 : 200);
        }
        if (input.data.verdict === "product_bug" || input.data.verdict === "environment_issue") {
          const status = input.data.verdict === "product_bug" ? "blocked_product" : "blocked_environment";
          const updated = await caseHubRepository.updateChangeSet(owner(c), changeSet.id, changeSet.revision, { status, error: input.data.feedback });
          return c.json({ result: reviewed, changeSet: updated });
        }
        if (input.data.verdict === "request_changes") {
          let revising = changeSet;
          if (changeSet.status === "awaiting_review") {
            try {
              revising = await caseHubRepository.updateChangeSet(owner(c), changeSet.id, changeSet.revision, { status: "revising" });
            } catch (error) {
              const concurrent = await caseHubRepository.getChangeSet(owner(c), changeSet.id);
              if (!concurrent || !["revising", "verifying"].includes(concurrent.status)) throw error;
              return c.json({ result: reviewed, changeSet: concurrent }, 202);
            }
          } else if (["revising", "verifying"].includes(changeSet.status)) {
            return c.json({ result: reviewed, changeSet }, 202);
          }
          await dispatchE2ERepair(c.get("mastra"), owner(c), reviewed.runId, {
            verdict: "request_changes",
            reviewerId: principal.subjectId,
            caseVersionId: reviewed.caseVersionId,
            feedback: `[${reviewed.caseId}] ${input.data.feedback}`,
          }, c.get("requestContext"));
          return c.json({ result: reviewed, changeSet: revising }, 202);
        }
        const results = await caseHubRepository.listResults(owner(c), changeSet.id);
        if (!allLatestResultsApproved(results)) return c.json({ result: reviewed, changeSet });
        const finalVerifying = await caseHubRepository.updateChangeSet(owner(c), changeSet.id, changeSet.revision, { status: "final_verifying" });
        await resumeE2EWithVerdict(c.get("mastra"), owner(c), reviewed.runId, { verdict: "approve", reviewerId: principal.subjectId }, c.get("requestContext"));
        const ready = await caseHubRepository.updateChangeSet(owner(c), finalVerifying.id, finalVerifying.revision, { status: "ready_to_merge" });
        return c.json({ result: reviewed, changeSet: ready });
      } catch (error) {
        return c.json({ error: "case_review_failed", ...errorBody(error, crypto.randomUUID()) }, 409);
      }
    },
  }),
  registerApiRoute("/v1/case-hub/runs", {
    method: "POST",
    handler: async c => c.json({
      error: "text_case_review_required",
      message: "直接创建 E2E Run 已停用；请从已批准文字用例的 Review Plan 发起。",
    }, 409),
  }),
  registerApiRoute("/v1/case-hub/runs/:runId", {
    method: "GET",
    handler: async c => {
      const run = await runRepository.get(owner(c), c.req.param("runId"));
      return run ? c.json(run) : c.json({ error: "not_found" }, 404);
    },
  }),
  registerApiRoute("/v1/case-hub/runs/:runId/events", {
    method: "GET",
    handler: async c => {
      const ownerScope = owner(c);
      const runId = c.req.param("runId");
      if (!await runRepository.get(ownerScope, runId)) return c.json({ error: "not_found" }, 404);
      if (c.req.header("accept")?.includes("text/event-stream")) {
        return runEventResponse(ownerScope, runId, c.req.raw.signal);
      }
      return c.json({ events: await runRepository.events(ownerScope, runId) });
    },
  }),
  registerApiRoute("/v1/case-hub/trace-viewer/*", {
    method: "GET",
    handler: async c => {
      const relativePath = traceViewerRelativePath(c.req.url);
      if (!relativePath) return c.json({ error: "not_found" }, 404);
      if (relativePath === "ping") return c.body("");
      const root = playwrightTraceViewerRoot();
      const target = resolve(root, relativePath);
      if (target !== root && !target.startsWith(`${root}${sep}`)) return c.json({ error: "not_found" }, 404);
      const content = await readFile(target).catch(() => undefined);
      if (!content) return c.json({ error: "not_found" }, 404);
      c.header("content-type", traceViewerContentType(target));
      c.header("cache-control", relativePath === "index.html" || relativePath === "sw.bundle.js" ? "no-cache" : "public, max-age=31536000, immutable");
      c.header("service-worker-allowed", "/v1/case-hub/trace-viewer/");
      if (relativePath === "index.html") {
        c.header("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' data: blob:");
      }
      return c.body(content);
    },
  }),
  registerApiRoute("/v1/case-hub/runs/:runId/artifacts", {
    method: "GET",
    handler: async c => {
      const run = await runRepository.get(owner(c), c.req.param("runId"));
      return run ? c.json({ artifacts: run.artifacts }) : c.json({ error: "not_found" }, 404);
    },
  }),
  registerApiRoute("/v1/case-hub/runs/:runId/artifacts/:artifactId", {
    method: "GET",
    handler: async c => {
      const run = await runRepository.get(owner(c), c.req.param("runId"));
      const artifact = run?.artifacts.find(item => item.id === c.req.param("artifactId"));
      if (!artifact) return c.json({ error: "not_found" }, 404);
      try {
        const artifactOwner = owner(c);
        const size = await artifactStore.size(artifactOwner, artifact);
        const rangeHeader = c.req.header("range");
        let range: ArtifactByteRange | undefined;
        try {
          range = rangeHeader ? parseArtifactByteRange(rangeHeader, size) : undefined;
        } catch (error) {
          if (!(error instanceof ArtifactRangeNotSatisfiableError)) throw error;
          c.header("accept-ranges", "bytes");
          c.header("content-range", `bytes */${error.size}`);
          return c.body("", 416);
        }
        const content = range
          ? await artifactStore.open(artifactOwner, artifact, range)
          : await artifactStore.open(artifactOwner, artifact);
        c.header("content-type", artifact.contentType ?? (artifact.kind === "trace" && /trace\.zip$/iu.test(artifact.name) ? "application/zip" : "application/octet-stream"));
        c.header("content-disposition", artifactContentDisposition(artifact.name));
        c.header("accept-ranges", "bytes");
        if (content.contentLength !== undefined) c.header("content-length", String(content.contentLength));
        if (range) {
          c.header("content-range", `bytes ${range.start}-${range.end}/${size}`);
          return c.body(content.body, 206);
        }
        return c.body(content.body);
      } catch (error) {
        if (error instanceof ArtifactOwnershipError) return c.json({ error: "forbidden" }, 403);
        if (error instanceof ArtifactNotFoundError) return c.json({ error: "not_found" }, 404);
        if (error instanceof ArtifactRangeNotSatisfiableError) {
          c.header("accept-ranges", "bytes");
          c.header("content-range", `bytes */${error.size}`);
          return c.body("", 416);
        }
        throw error;
      }
    },
  }),
  registerApiRoute("/v1/case-hub/runs/:runId/rerun", {
    method: "POST",
    handler: async c => {
      try { return c.json(await rerunE2E(c.get("mastra"), owner(c), c.req.param("runId"), c.get("requestContext"), authenticatedUser(c)?.id), 202); }
      catch (error) { return c.json({ error: "rerun_failed", ...errorBody(error, crypto.randomUUID()) }, 409); }
    },
  }),
  registerApiRoute("/v1/case-hub/runs/:runId/cancel", {
    method: "POST",
    handler: async c => {
      try { return c.json(await cancelE2ERun(c.get("mastra"), owner(c), c.req.param("runId"))); }
      catch (error) { return c.json(errorBody(error, crypto.randomUUID()), 409); }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId", {
    method: "POST",
    handler: async c => {
      try {
        const session = await requireSandboxPool().session(sandboxScope(c));
        return c.json({ ...await session.claim(), ordinal: session.lease.ordinal });
      } catch (error) {
        return c.json({ error: "sandbox_unavailable", ...errorBody(error, crypto.randomUUID()) }, 503);
      }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId/browser/start", {
    method: "POST",
    handler: async c => {
      const parsed = SandboxBrowserStartSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      try {
        const session = await requireSandboxPool().session(sandboxScope(c));
        return c.json({ ...await session.browserStart({
          width: parsed.data.width,
          height: parsed.data.height,
          ...(parsed.data.url ? { url: parsed.data.url } : {}),
        }), ordinal: session.lease.ordinal });
      } catch (error) {
        return c.json({ error: "browser_start_failed", ...errorBody(error, crypto.randomUUID()) }, 503);
      }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId/browser/action", {
    method: "POST",
    handler: async c => {
      const parsed = SandboxBrowserActionSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      try {
        const session = await requireSandboxPool().session(sandboxScope(c));
        return c.json({ ...await session.browserAction(parsed.data), ordinal: session.lease.ordinal });
      } catch (error) {
        return c.json({ error: "browser_action_failed", ...errorBody(error, crypto.randomUUID()) }, 503);
      }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId/browser/frame", {
    method: "GET",
    handler: async c => {
      try {
        const frame = await (await requireSandboxPool().session(sandboxScope(c))).browserFrame();
        c.header("content-type", "image/jpeg");
        c.header("cache-control", "no-store");
        if (frame.url) c.header("x-qasey-browser-url", encodeURIComponent(frame.url));
        if (frame.title) c.header("x-qasey-browser-title", encodeURIComponent(frame.title));
        return c.body(new Uint8Array(frame.image));
      } catch (error) {
        return c.json({ error: "browser_frame_failed", ...errorBody(error, crypto.randomUUID()) }, 503);
      }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId/desktop/start", {
    method: "POST",
    handler: async c => {
      const parsed = SandboxDesktopStartSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      try {
        const started = await requireSandboxPool().startDesktop(sandboxScope(c), parsed.data);
        return c.json({ ...started.state, ordinal: started.session.lease.ordinal });
      } catch (error) {
        return c.json({ error: "desktop_start_failed", ...errorBody(error, crypto.randomUUID()) }, 503);
      }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId/desktop/action", {
    method: "POST",
    handler: async c => {
      const parsed = SandboxDesktopActionSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      try {
        const session = await requireSandboxPool().session(sandboxScope(c));
        return c.json({ ...await session.desktopAction(parsed.data), ordinal: session.lease.ordinal });
      } catch (error) {
        return c.json({ error: "desktop_action_failed", ...errorBody(error, crypto.randomUUID()) }, 503);
      }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId/desktop/tool", {
    method: "POST",
    handler: async c => {
      const parsed = SandboxDesktopToolSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      try { return c.json(await (await requireSandboxPool().session(sandboxScope(c))).desktopTool(parsed.data)); }
      catch (error) { return c.json({ error: "desktop_tool_failed", ...errorBody(error, crypto.randomUUID()) }, 503); }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId/desktop/app", {
    method: "POST",
    handler: async c => {
      const parsed = SandboxDesktopApplicationSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      try {
        const session = await requireSandboxPool().session(sandboxScope(c));
        return c.json({ ...await session.desktopApplication(parsed.data), ordinal: session.lease.ordinal });
      } catch (error) {
        return c.json({ error: "desktop_app_failed", ...errorBody(error, crypto.randomUUID()) }, 503);
      }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId/desktop/frame", {
    method: "GET",
    handler: async c => {
      try {
        const frame = await (await requireSandboxPool().session(sandboxScope(c))).desktopFrame();
        c.header("content-type", "image/png");
        c.header("cache-control", "no-store");
        return c.body(new Uint8Array(frame));
      } catch (error) {
        return c.json({ error: "desktop_frame_failed", ...errorBody(error, crypto.randomUUID()) }, 503);
      }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId/desktop/stop", {
    method: "POST",
    handler: async c => {
      try {
        const session = await requireSandboxPool().session(sandboxScope(c));
        return c.json({ ...await session.desktopStop(), ordinal: session.lease.ordinal });
      } catch (error) {
        return c.json({ error: "desktop_stop_failed", ...errorBody(error, crypto.randomUUID()) }, 503);
      }
    },
  }),
  registerApiRoute("/v1/sandbox-sessions/:sessionId/stop", {
    method: "POST",
    handler: async c => {
      try {
        await requireSandboxPool().release(sandboxScope(c));
        return c.json({ stopped: true });
      } catch (error) {
        return c.json({ error: "sandbox_stop_failed", ...errorBody(error, crypto.randomUUID()) }, 503);
      }
    },
  }),
  registerApiRoute("/runs/:runId", {
    method: "GET",
    handler: async c => {
      const id = c.req.param("runId");
      const run = await runRepository.get(owner(c), id);
      if (!run) return c.html("<h1>Run not found</h1>", 404);
      const events = await runRepository.events(owner(c), id);
      const payload = JSON.stringify({ run, events }).replaceAll("<", "\\u003c");
      return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Qasey Run</title><style>body{font-family:ui-sans-serif,system-ui;background:#0b1020;color:#e9eefc;margin:0;padding:32px}main{max-width:960px;margin:auto}.card{background:#151d33;border:1px solid #293655;border-radius:14px;padding:20px;margin:16px 0}.status,a{color:#7dd3fc}li{margin:8px 0}code{color:#c4b5fd}</style></head><body><main><h1>Qasey E2E Run</h1><div id="app"></div></main><script>const {run,events}=${payload};const app=document.getElementById('app');const card=(title)=>{const d=document.createElement('div');d.className='card';const h=document.createElement('h3');h.textContent=title;d.append(h);app.append(d);return d};const overview=card(run.framework+' · '+run.repository.repository);const status=document.createElement('div');status.className='status';status.textContent=run.status;const code=document.createElement('code');code.textContent=run.id;overview.append(status,code);const timeline=card('Timeline');const tl=document.createElement('ul');for(const e of events){const li=document.createElement('li');li.textContent=e.at+' · '+e.message;tl.append(li)}timeline.append(tl);const artifacts=card('Artifacts');const al=document.createElement('ul');for(const a of run.artifacts){const li=document.createElement('li');const link=document.createElement('a');link.textContent=a.kind+' · '+a.name;link.href='/v1/case-hub/runs/'+encodeURIComponent(run.id)+'/artifacts/'+encodeURIComponent(a.id);link.target='_blank';li.append(link);al.append(li)}artifacts.append(al);</script></body></html>`);
    },
  }),
];

async function settleClosedPullRequest(ownerScope: OwnerScope, changeSet: CaseHubChangeSet, merged: boolean): Promise<void> {
  if (merged) {
    await caseHubRepository.activateApprovedVersions(ownerScope, changeSet.id);
    await caseHubRepository.updateChangeSet(ownerScope, changeSet.id, changeSet.revision, { status: "merged" });
  } else {
    await caseHubRepository.updateChangeSet(ownerScope, changeSet.id, changeSet.revision, { status: "abandoned" });
  }
}

function parseGitHubPullRequestUrl(value: string): { owner: string; repository: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/u.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { owner: match[1], repository: match[2], number: Number(match[3]) };
}

const routePolicies: Record<string, { id: string; access: PrimitiveAccessPolicy; public?: boolean }> = {
  "GET /healthz": { id: "healthz", access: { permission: "platform.health.read", audiences: ["admin-ui", "api", "service", "channel"] }, public: true },
  "GET /readyz": { id: "readyz", access: { permission: "platform.health.read", audiences: ["admin-ui", "api", "service", "channel"] }, public: true },
  "GET /internal/metrics": { id: "metrics", access: { permission: "platform.metrics.read", audiences: ["admin-ui", "service"] } },
  "GET /internal/e2e/version": { id: "e2e-environment-version", access: { permission: "qasey.test-environments.provision", audiences: ["service"] } },
  "POST /internal/e2e/leases": { id: "e2e-lease-create", access: { permission: "qasey.test-environments.provision", audiences: ["service"] } },
  "DELETE /internal/e2e/leases/:leaseId": { id: "e2e-lease-delete", access: { permission: "qasey.test-environments.provision", audiences: ["service"] } },
  "POST /internal/case-hub/change-sets/:changeSetId/reconcile": { id: "change-set-pr-reconcile", access: { permission: "qasey.cases.write", audiences: ["service"] } },
  "GET /v1/dev-runtimes/events": { id: "dev-runtime-events", access: { permission: "qasey.channel.receive", audiences: ["channel"] }, public: true },
  "POST /v1/dev-runtimes/:runtimeId/jobs/:jobId/events": { id: "dev-runtime-job-events", access: { permission: "qasey.channel.receive", audiences: ["channel"] }, public: true },
  "POST /v1/dev-runtime-approvals/:approvalId": { id: "dev-runtime-approval", access: { permission: "qasey.channel.receive", audiences: ["channel"] }, public: true },
  "POST /webhooks/jira": { id: "jira-webhook", access: { permission: "qasey.channel.receive", audiences: ["channel"] } },
  "POST /webhooks/github": { id: "github-webhook", access: { permission: "qasey.channel.receive", audiences: ["channel"] }, public: true },
  "GET /v1/qasey/conversations": { id: "qasey-conversation-list", access: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api"] } },
  "POST /v1/qasey/conversations": { id: "qasey-conversation-create", access: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api"] } },
  "GET /v1/qasey/conversations/:conversationId": { id: "qasey-conversation-read", access: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api"] } },
  "GET /v1/qasey/conversations/:conversationId/events": { id: "conversation-events-read", access: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/qasey/conversations/:conversationId/messages": { id: "qasey-conversation-message", access: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api"] } },
  "POST /v1/qasey/conversations/:conversationId/actions": { id: "qasey-conversation-action", access: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api"] } },
  "GET /v1/qasey/conversations/:conversationId/turns/:turnId/events": { id: "qasey-conversation-events", access: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api"] } },
  "POST /v1/qasey/tasks": { id: "qasey-task", access: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api"] } },
  "GET /v1/case-hub/runs": { id: "run-list", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/case-hub/runs": { id: "run-create", access: { permission: "qasey.runs.write", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/cases": { id: "case-list", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api", "service"] } },
  "DELETE /v1/case-hub/cases/:caseId": { id: "case-delete", access: { permission: "qasey.cases.write", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/cases/:caseId": { id: "case-read", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/review-plans": { id: "case-review-plan-list", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api"] } },
  "POST /v1/case-hub/review-plans/:planId/cancel": { id: "case-review-plan-cancel", access: { permission: "qasey.cases.write", audiences: ["admin-ui", "api"] } },
  "GET /v1/case-hub/review-plans/:planId": { id: "case-review-plan-read", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api"] } },
  "PATCH /v1/case-hub/review-plans/:planId/items/:itemId": { id: "case-review-item-update", access: { permission: "qasey.cases.write", audiences: ["admin-ui", "api"] } },
  "POST /v1/case-hub/review-plans/:planId/items/:itemId/remove": { id: "case-review-item-remove", access: { permission: "qasey.cases.write", audiences: ["admin-ui", "api"] } },
  "POST /v1/case-hub/review-plans/:planId/items/:itemId/restore": { id: "case-review-item-restore", access: { permission: "qasey.cases.write", audiences: ["admin-ui", "api"] } },
  "POST /v1/case-hub/review-plans/:planId/items/:itemId/approve": { id: "case-review-item-approve", access: { permission: "qasey.cases.write", audiences: ["admin-ui", "api"] } },
  "POST /v1/case-hub/review-plans/:planId/approve": { id: "case-review-plan-approve", access: { permission: "qasey.cases.write", audiences: ["admin-ui", "api"] } },
  "GET /v1/case-hub/change-sets": { id: "change-set-list", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/preflight": { id: "e2e-preflight", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/case-hub/change-sets": { id: "change-set-create", access: { permission: "qasey.cases.write", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/case-hub/change-sets/:changeSetId/cancel": { id: "change-set-cancel", access: { permission: "qasey.cases.write", audiences: ["admin-ui", "api"] } },
  "GET /v1/case-hub/change-sets/:changeSetId": { id: "change-set-read", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/case-hub/results/:resultId/review": { id: "case-result-review", access: { permission: "qasey.results.approve", audiences: ["admin-ui", "api"] } },
  "GET /v1/case-hub/runs/:runId": { id: "run-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/runs/:runId/events": { id: "run-events-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/results/:resultId/evidence-timeline": { id: "case-result-evidence-timeline", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api"] } },
  "GET /v1/case-hub/trace-viewer/*": { id: "trace-viewer-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api"] } },
  "GET /v1/case-hub/runs/:runId/artifacts": { id: "run-artifacts-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/runs/:runId/artifacts/:artifactId": { id: "run-artifact-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/case-hub/runs/:runId/rerun": { id: "run-rerun", access: { permission: "qasey.runs.write", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/case-hub/runs/:runId/cancel": { id: "run-cancel", access: { permission: "qasey.runs.write", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/sandbox-sessions/:sessionId": { id: "sandbox-session-claim", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "POST /v1/sandbox-sessions/:sessionId/browser/start": { id: "sandbox-browser-start", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "POST /v1/sandbox-sessions/:sessionId/browser/action": { id: "sandbox-browser-action", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "GET /v1/sandbox-sessions/:sessionId/browser/frame": { id: "sandbox-browser-frame", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "POST /v1/sandbox-sessions/:sessionId/desktop/start": { id: "sandbox-desktop-start", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "POST /v1/sandbox-sessions/:sessionId/desktop/action": { id: "sandbox-desktop-action", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "POST /v1/sandbox-sessions/:sessionId/desktop/tool": { id: "sandbox-desktop-tool", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "POST /v1/sandbox-sessions/:sessionId/desktop/app": { id: "sandbox-desktop-app", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "GET /v1/sandbox-sessions/:sessionId/desktop/frame": { id: "sandbox-desktop-frame", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "POST /v1/sandbox-sessions/:sessionId/desktop/stop": { id: "sandbox-desktop-stop", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "POST /v1/sandbox-sessions/:sessionId/stop": { id: "sandbox-session-stop", access: { permission: "qasey.sandbox.use", audiences: ["admin-ui", "api"] } },
  "GET /runs/:runId": { id: "run-page", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api"] } },
};

export const qaseyOwnedApiRoutes: readonly OwnedApiRoute[] = apiRoutes.map(route => {
  const policy = routePolicies[`${route.method} ${route.path}`];
  if (!policy) throw new Error(`Qasey route is missing permission metadata: ${route.method} ${route.path}`);
  return { route, ...policy };
});
