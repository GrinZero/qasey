import { registerApiRoute } from "@mastra/core/server";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CreateE2ERunSchema, QaVerdictInputSchema } from "../../packages/contracts/src/index.ts";
import { normalizeJiraWebhook } from "../../packages/domain/src/index.ts";
import { config, channelDeliveryInbox, jiraClient, runRepository } from "./runtime.ts";
import { cancelE2ERun, createAndStartE2ERun, rerunE2E, resumeE2EWithVerdict } from "./e2e-workflow.ts";
import { ownerScopeFromRequestContext } from "../platform/context/owner-scope.ts";
import type { OwnedApiRoute, PrimitiveAccessPolicy } from "../runtime/application.ts";
import { conversationScope } from "../platform/context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../platform/context/schema.ts";
import { OAuthPrincipalSchema } from "../platform/auth/oauth-principal.ts";
import type { PlatformGoogleUser } from "../platform/auth/google-oidc.ts";
import { runQaseyTaskWorkflow } from "./qasey-task-workflow.ts";

const QaseyTaskRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
}).strict();

function authenticatedUser(c: { get(key: "requestContext"): { get(key: string): unknown } }): PlatformGoogleUser | undefined {
  return c.get("requestContext").get("user") as PlatformGoogleUser | undefined;
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

export const apiRoutes = [
  registerApiRoute("/healthz", { method: "GET", requiresAuth: false, handler: async c => c.json({ status: "ok", service: "qasey" }) }),
  registerApiRoute("/readyz", { method: "GET", requiresAuth: false, handler: async c => c.json({ status: "ready", storage: config.DATABASE_URL ? "postgres" : "memory" }) }),
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
        const result = await runQaseyTaskWorkflow(c.get("mastra"), {
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
          sessionId: identity.userId,
          chatInput: parsed.data.prompt,
          actor: { id: identity.userId, tenantId: identity.tenantId },
          source: {},
          attachments: [],
        };
        return c.json(await runQaseyTaskWorkflow(c.get("mastra"), context, { requestContext }));
      } catch (error) {
        return c.json({ error: "qasey_task_failed", ...errorBody(error, requestId) }, 502);
      }
    },
  }),
  registerApiRoute("/v1/runs", {
    method: "GET",
    handler: async c => c.json({ runs: await runRepository.list(owner(c), Number(c.req.query("limit") ?? 100)) }),
  }),
  registerApiRoute("/v1/runs", {
    method: "POST",
    handler: async c => {
      const parsed = CreateE2ERunSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      try { return c.json(await createAndStartE2ERun(c.get("mastra"), owner(c), parsed.data, c.get("requestContext"), authenticatedUser(c)?.id), 202); }
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
      if (!artifact?.uri.startsWith("file://")) return c.json({ error: "not_found" }, 404);
      try {
        const [root, target] = await Promise.all([realpath(resolve(config.QASEY_ARTIFACT_DIR)), realpath(fileURLToPath(artifact.uri))]);
        if (target !== root && !target.startsWith(`${root}/`)) return c.json({ error: "forbidden" }, 403);
        const content = await readFile(target);
        c.header("content-type", artifact.contentType ?? "application/octet-stream");
        c.header("content-disposition", `inline; filename="${artifact.name.replace(/["\\]/g, "_")}"`);
        return c.body(content);
      } catch { return c.json({ error: "not_found" }, 404); }
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
  registerApiRoute("/v1/runs/:runId/qa-verdict", {
    method: "POST",
    handler: async c => {
      const parsed = QaVerdictInputSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      const reviewerId = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal")).subjectId;
      try { return c.json(await resumeE2EWithVerdict(c.get("mastra"), owner(c), c.req.param("runId"), { ...parsed.data, reviewerId }, c.get("requestContext"))); }
      catch (error) { return c.json(errorBody(error, crypto.randomUUID()), 409); }
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

const routePolicies: Record<string, { id: string; access: PrimitiveAccessPolicy; public?: boolean }> = {
  "GET /healthz": { id: "healthz", access: { permission: "platform.health.read", audiences: ["admin-ui", "api", "service", "channel"] }, public: true },
  "GET /readyz": { id: "readyz", access: { permission: "platform.health.read", audiences: ["admin-ui", "api", "service", "channel"] }, public: true },
  "POST /webhooks/jira": { id: "jira-webhook", access: { permission: "qasey.channel.receive", audiences: ["channel"] } },
  "POST /v1/qasey/tasks": { id: "qasey-task", access: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api"] } },
  "GET /v1/runs": { id: "run-list", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/runs": { id: "run-create", access: { permission: "qasey.runs.write", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/runs/:runId": { id: "run-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/runs/:runId/events": { id: "run-events-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/runs/:runId/artifacts": { id: "run-artifacts-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "GET /v1/runs/:runId/artifacts/:artifactId": { id: "run-artifact-read", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/runs/:runId/rerun": { id: "run-rerun", access: { permission: "qasey.runs.write", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/runs/:runId/cancel": { id: "run-cancel", access: { permission: "qasey.runs.write", audiences: ["admin-ui", "api", "service"] } },
  "POST /v1/runs/:runId/qa-verdict": { id: "run-verdict", access: { permission: "qasey.runs.approve", audiences: ["admin-ui", "api"] } },
  "GET /runs/:runId": { id: "run-page", access: { permission: "qasey.runs.read", audiences: ["admin-ui", "api"] } },
};

export const qaseyOwnedApiRoutes: readonly OwnedApiRoute[] = apiRoutes.map(route => {
  const policy = routePolicies[`${route.method} ${route.path}`];
  if (!policy) throw new Error(`Qasey route is missing permission metadata: ${route.method} ${route.path}`);
  return { route, ...policy };
});
