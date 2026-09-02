import { registerApiRoute } from "@mastra/core/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CaseHubResultReviewInputSchema, CreateCaseHubChangeSetSchema, CreateE2ERunRequestSchema, type CaseHubChangeSet, type CaseHubResult, type OwnerScope } from "../../../../packages/contracts/src/index.ts";
import { freezeE2EContext, normalizeJiraWebhook } from "../../../../packages/domain/src/index.ts";
import { artifactStore, caseHubRepository, channelDeliveryInbox, config, e2eFixtureLeaseService, githubClient, jiraClient, runRepository, sandboxPoolClient } from "../../runtime.ts";
import { ArtifactNotFoundError, ArtifactOwnershipError } from "../../../../packages/e2e/src/index.ts";
import { cancelE2ERun, createAndStartE2ERun, rerunE2E, resumeE2EWithVerdict } from "../../workflows/e2e-workflow.ts";
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

function authenticatedUser(c: { get(key: "requestContext"): { get(key: string): unknown } }): PlatformBrowserUser | undefined {
  return c.get("requestContext").get("user") as PlatformBrowserUser | undefined;
}

function owner(c: { get(key: "requestContext"): import("@mastra/core/request-context").RequestContext }) {
  return ownerScopeFromRequestContext(c.get("requestContext"));
}

function errorBody(error: unknown, requestId: string) {
  const message = config.NODE_ENV === "production"
    ? "The request could not be completed. Use the request ID to inspect server logs."
    : error instanceof Error ? error.message : String(error);
  return { message, requestId };
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
  registerApiRoute("/v1/runs", {
    method: "GET",
    handler: async c => c.json({ runs: await runRepository.list(owner(c), Number(c.req.query("limit") ?? 100)) }),
  }),
  registerApiRoute("/v1/case-hub/cases", {
    method: "GET",
    handler: async c => c.json({ cases: await caseHubRepository.listCases(owner(c), c.req.query("q") ?? "") }),
  }),
  registerApiRoute("/v1/case-hub/cases/:caseId", {
    method: "GET",
    handler: async c => {
      const caseRecord = await caseHubRepository.getCase(owner(c), c.req.param("caseId"));
      if (!caseRecord) return c.json({ error: "not_found" }, 404);
      return c.json({ case: caseRecord, versions: await caseHubRepository.versionsForCase(owner(c), caseRecord.id) });
    },
  }),
  registerApiRoute("/v1/case-hub/change-sets", {
    method: "GET",
    handler: async c => c.json({ changeSets: await caseHubRepository.listChangeSets(owner(c), Number(c.req.query("limit") ?? 100)) }),
  }),
  registerApiRoute("/v1/case-hub/change-sets", {
    method: "POST",
    handler: async c => {
      const parsed = CreateCaseHubChangeSetSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      if (parsed.data.requirement.blockingQuestions.length > 0) {
        return c.json({ error: "blocking_questions", questions: parsed.data.requirement.blockingQuestions }, 409);
      }
      const requestContext = c.get("requestContext");
      const principal = OAuthPrincipalSchema.parse(requestContext.get("platform-principal"));
      const requestId = String(requestContext.get("requestId") ?? crypto.randomUUID());
      const sessionId = String(requestContext.get("sessionId") ?? requestId);
      const webE2EConfiguration = webE2EConfigurationFromSkill();
      const requirement = freezeE2EContext(parsed.data.requirement, {
        sessionId,
        threadId: String(requestContext.get(MASTRA_THREAD_ID_KEY) ?? sessionId),
        taskRunId: String(requestContext.get("taskId") ?? requestContext.get("executionId") ?? requestId),
        requestId,
        resourceId: String(requestContext.get(MASTRA_RESOURCE_ID_KEY) ?? principal.subjectId),
      });
      try {
        const changeSet = await caseHubRepository.createChangeSet(owner(c), {
          requirement,
          proposals: parsed.data.proposals,
          repository: webE2EConfiguration.target,
          createdBy: principal.subjectId,
          environmentSourceSha: e2eFixtureLeaseService.version().sourceSha,
        });
        const run = await createAndStartE2ERun(c.get("mastra"), owner(c), {
          sourceSessionId: sessionId,
          changeSetId: changeSet.id,
          handoff: parsed.data.requirement,
          repository: webE2EConfiguration.target,
          playwrightVerification: webE2EConfiguration.verification,
          platform: "web",
          framework: "playwright",
        }, requestContext, principal.subjectId);
        return c.json({ changeSet, run }, 202);
      } catch (error) {
        return c.json({ error: "change_set_create_failed", ...errorBody(error, requestId) }, 409);
      }
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
  registerApiRoute("/v1/case-hub/results/:resultId/review", {
    method: "POST",
    handler: async c => {
      const input = CaseHubResultReviewInputSchema.safeParse(await c.req.json());
      if (!input.success) return c.json({ error: "validation_error", details: input.error.issues }, 400);
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      try {
        const reviewed = await caseHubRepository.reviewResult(owner(c), c.req.param("resultId"), principal.subjectId, input.data);
        const changeSet = await caseHubRepository.getChangeSet(owner(c), reviewed.changeSetId);
        if (!changeSet) return c.json({ error: "not_found" }, 404);
        if (input.data.verdict === "product_bug" || input.data.verdict === "environment_issue") {
          const status = input.data.verdict === "product_bug" ? "blocked_product" : "blocked_environment";
          const updated = await caseHubRepository.updateChangeSet(owner(c), changeSet.id, changeSet.revision, { status, error: input.data.feedback });
          return c.json({ result: reviewed, changeSet: updated });
        }
        if (input.data.verdict === "request_changes") {
          const revising = await caseHubRepository.updateChangeSet(owner(c), changeSet.id, changeSet.revision, { status: "revising" });
          await resumeE2EWithVerdict(c.get("mastra"), owner(c), reviewed.runId, {
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
  registerApiRoute("/v1/runs", {
    method: "POST",
    handler: async c => {
      const parsed = CreateE2ERunRequestSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      if (parsed.data.platform !== "web" || parsed.data.framework !== "playwright") {
        return c.json({ error: "unsupported_e2e_target", message: "CodeTask-backed E2E currently supports Web Playwright only" }, 400);
      }
      const requestContext = c.get("requestContext");
      try {
        const webE2EConfiguration = webE2EConfigurationFromSkill();
        const trustedInput = {
          ...parsed.data,
          sourceSessionId: String(requestContext.get("sessionId")),
          repository: webE2EConfiguration.target,
          playwrightVerification: webE2EConfiguration.verification,
        };
        return c.json(await createAndStartE2ERun(c.get("mastra"), owner(c), trustedInput, requestContext, authenticatedUser(c)?.id), 202);
      }
      catch (error) { return c.json(errorBody(error, crypto.randomUUID()), 400); }
    },
  }),
  registerApiRoute("/v1/runs/:runId", {
    method: "GET",
    handler: async c => {
      const run = await runRepository.get(owner(c), c.req.param("runId"));
      return run ? c.json(run) : c.json({ error: "not_found" }, 404);
    },
  }),
  registerApiRoute("/v1/runs/:runId/events", {
    method: "GET",
    handler: async c => c.json({ events: await runRepository.events(owner(c), c.req.param("runId")) }),
  }),
  registerApiRoute("/v1/runs/:runId/artifacts", {
    method: "GET",
    handler: async c => {
      const run = await runRepository.get(owner(c), c.req.param("runId"));
      return run ? c.json({ artifacts: run.artifacts }) : c.json({ error: "not_found" }, 404);
    },
  }),
  registerApiRoute("/v1/runs/:runId/artifacts/:artifactId", {
    method: "GET",
    handler: async c => {
      const run = await runRepository.get(owner(c), c.req.param("runId"));
      const artifact = run?.artifacts.find(item => item.id === c.req.param("artifactId"));
      if (!artifact) return c.json({ error: "not_found" }, 404);
      try {
        const content = await artifactStore.open(owner(c), artifact);
        c.header("content-type", artifact.contentType ?? "application/octet-stream");
        c.header("content-disposition", `inline; filename="${artifact.name.replace(/["\\]/g, "_")}"`);
        if (content.contentLength !== undefined) c.header("content-length", String(content.contentLength));
        return c.body(content.body);
      } catch (error) {
        if (error instanceof ArtifactOwnershipError) return c.json({ error: "forbidden" }, 403);
        if (error instanceof ArtifactNotFoundError) return c.json({ error: "not_found" }, 404);
        throw error;
      }
    },
  }),
  registerApiRoute("/v1/runs/:runId/rerun", {
    method: "POST",
    handler: async c => {
      try { return c.json(await rerunE2E(c.get("mastra"), owner(c), c.req.param("runId"), c.get("requestContext"), authenticatedUser(c)?.id), 202); }
      catch (error) { return c.json({ error: "rerun_failed", ...errorBody(error, crypto.randomUUID()) }, 409); }
    },
  }),
  registerApiRoute("/v1/runs/:runId/cancel", {
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
      return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Qasey Run</title><style>body{font-family:ui-sans-serif,system-ui;background:#0b1020;color:#e9eefc;margin:0;padding:32px}main{max-width:960px;margin:auto}.card{background:#151d33;border:1px solid #293655;border-radius:14px;padding:20px;margin:16px 0}.status,a{color:#7dd3fc}li{margin:8px 0}code{color:#c4b5fd}</style></head><body><main><h1>Qasey E2E Run</h1><div id="app"></div></main><script>const {run,events}=${payload};const app=document.getElementById('app');const card=(title)=>{const d=document.createElement('div');d.className='card';const h=document.createElement('h3');h.textContent=title;d.append(h);app.append(d);return d};const overview=card(run.framework+' · '+run.repository.repository);const status=document.createElement('div');status.className='status';status.textContent=run.status;const code=document.createElement('code');code.textContent=run.id;overview.append(status,code);const timeline=card('Timeline');const tl=document.createElement('ul');for(const e of events){const li=document.createElement('li');li.textContent=e.at+' · '+e.message;tl.append(li)}timeline.append(tl);const artifacts=card('Artifacts');const al=document.createElement('ul');for(const a of run.artifacts){const li=document.createElement('li');const link=document.createElement('a');link.textContent=a.kind+' · '+a.name;link.href='/v1/runs/'+encodeURIComponent(run.id)+'/artifacts/'+encodeURIComponent(a.id);link.target='_blank';li.append(link);al.append(li)}artifacts.append(al);</script></body></html>`);
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
  "POST /v1/qasey/tasks": { id: "qasey-task", access: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api"] } },
  "GET /v1/runs": { id: "run-list", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/runs": { id: "run-create", access: { permission: "qasey.runs.write", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/cases": { id: "case-list", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/cases/:caseId": { id: "case-read", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/change-sets": { id: "change-set-list", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/case-hub/change-sets": { id: "change-set-create", access: { permission: "qasey.cases.write", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/case-hub/change-sets/:changeSetId": { id: "change-set-read", access: { permission: "qasey.cases.read", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/case-hub/results/:resultId/review": { id: "case-result-review", access: { permission: "qasey.results.approve", audiences: ["admin-ui", "api"] } },
  "GET /v1/runs/:runId": { id: "run-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/runs/:runId/events": { id: "run-events-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/runs/:runId/artifacts": { id: "run-artifacts-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/runs/:runId/artifacts/:artifactId": { id: "run-artifact-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/runs/:runId/rerun": { id: "run-rerun", access: { permission: "qasey.runs.write", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/runs/:runId/cancel": { id: "run-cancel", access: { permission: "qasey.runs.write", audiences: ["admin-ui", "api", "service"] } },
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
