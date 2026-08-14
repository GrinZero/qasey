import { registerApiRoute } from "@mastra/core/server";
import type { GoogleUser } from "@mastra/auth-google";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateE2ERunSchema, QaVerdictSchema, QaseyRequestContextSchema, TriggerEnvelopeSchema } from "../../packages/contracts/src/index.ts";
import { createTriggerEnvelope, normalizeApiRequest, normalizeJiraWebhook } from "../../packages/domain/src/index.ts";
import { verifyWebhookToken } from "../../packages/adapters/src/index.ts";
import { config, eventInbox, runRepository, triggerQueue } from "./runtime.ts";
import { executeQasey } from "./service.ts";
import { cancelE2ERun, createAndStartE2ERun, rerunE2E, resumeE2EWithVerdict } from "./e2e-workflow.ts";

function authenticatedUser(c: { get(key: "requestContext"): { get(key: string): unknown } }): GoogleUser | undefined {
  return c.get("requestContext").get("user") as GoogleUser | undefined;
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
  registerApiRoute("/v1/qasey", {
    method: "POST",
    handler: async c => {
      const requestId = crypto.randomUUID();
      try {
        const body = await c.req.json<{ requestId?: string; sessionId?: string; chatInput?: string; actorId?: string }>();
        const user = c.get("requestContext").get("user") as GoogleUser | undefined;
        const actorId = user?.id ?? (config.NODE_ENV === "production" ? undefined : body.actorId);
        if (!body.sessionId || !body.chatInput || !actorId) return c.json({ error: "validation_error", requestId }, 400);
        const context = normalizeApiRequest({ sessionId: body.sessionId, chatInput: body.chatInput, actorId, ...(body.requestId ? { requestId: body.requestId } : {}) });
        if (!await eventInbox.accept(context.requestId)) return c.json({ error: "conflict", message: "Duplicate request", requestId: context.requestId }, 409);
        return c.json(await executeQasey(c.get("mastra"), context));
      } catch (error) { return c.json({ error: "internal_error", ...errorBody(error, requestId) }, 500); }
    },
  }),
  registerApiRoute("/v1/triggers", {
    method: "POST",
    requiresAuth: false,
    handler: async c => {
      const requestId = crypto.randomUUID();
      if (!verifyWebhookToken(c.req.header("authorization")?.replace(/^Bearer\s+/i, ""), config.QASEY_INGRESS_TOKEN)) {
        return c.json({ error: "unauthorized", requestId }, 401);
      }
      const body = await c.req.json();
      const envelope = TriggerEnvelopeSchema.safeParse(body?.envelope);
      const request = QaseyRequestContextSchema.safeParse(body?.request);
      if (!envelope.success || !request.success) return c.json({ error: "validation_error", requestId }, 400);
      const accepted = await triggerQueue.enqueue(envelope.data, request.data);
      return c.json({ accepted, duplicate: !accepted, traceId: envelope.data.traceId }, 202);
    },
  }),
  registerApiRoute("/webhooks/n8n", {
    method: "POST",
    requiresAuth: false,
    handler: async c => {
      const requestId = crypto.randomUUID();
      if (!verifyWebhookToken(c.req.header("x-qasey-webhook-token"), config.QASEY_INGRESS_TOKEN)) {
        return c.json({ error: "unauthorized", requestId }, 401);
      }
      const body = await c.req.json<{ requestId?: string; sessionId?: string; chatInput?: string; actorId?: string }>();
      if (!body.sessionId || !body.chatInput || !body.actorId) return c.json({ error: "validation_error", requestId }, 400);
      const request = normalizeApiRequest({ sessionId: body.sessionId, chatInput: body.chatInput, actorId: body.actorId, ...(body.requestId ? { requestId: body.requestId } : {}) });
      const envelope = createTriggerEnvelope({ request, source: "n8n", eventType: "workflow.forwarded" });
      const accepted = await triggerQueue.enqueue(envelope, request);
      return c.json({ accepted, duplicate: !accepted, traceId: envelope.traceId }, 202);
    },
  }),
  registerApiRoute("/webhooks/jira", {
    method: "POST",
    requiresAuth: false,
    handler: async c => {
      const requestId = crypto.randomUUID();
      if (!verifyWebhookToken(c.req.header("x-qasey-webhook-token"), config.JIRA_WEBHOOK_TOKEN)) {
        return c.json({ error: "unauthorized", requestId }, 401);
      }
      try {
        const body = await c.req.json();
        const context = normalizeJiraWebhook(body, config.JIRA_QASEY_ACCOUNT_ID);
        if (!context) return c.json({ accepted: false, reason: "ignored" }, 202);
        const envelope = createTriggerEnvelope({ request: context, source: "jira", eventType: String(body.webhookEvent ?? "comment_created") });
        const accepted = await triggerQueue.enqueue(envelope, context);
        return c.json({ accepted, duplicate: !accepted, traceId: envelope.traceId }, 202);
      } catch (error) {
        return c.json({ error: "upstream_error", ...errorBody(error, requestId) }, 502);
      }
    },
  }),
  registerApiRoute("/v1/runs", {
    method: "POST",
    handler: async c => {
      const parsed = CreateE2ERunSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      try { return c.json(await createAndStartE2ERun(c.get("mastra"), parsed.data, authenticatedUser(c)?.id), 202); }
      catch (error) { return c.json(errorBody(error, crypto.randomUUID()), 400); }
    },
  }),
  registerApiRoute("/v1/runs/:runId", {
    method: "GET",
    handler: async c => {
      const run = await runRepository.get(c.req.param("runId"));
      return run ? c.json(run) : c.json({ error: "not_found" }, 404);
    },
  }),
  registerApiRoute("/v1/runs/:runId/events", {
    method: "GET",
    handler: async c => c.json({ events: await runRepository.events(c.req.param("runId")) }),
  }),
  registerApiRoute("/v1/runs/:runId/artifacts", {
    method: "GET",
    handler: async c => {
      const run = await runRepository.get(c.req.param("runId"));
      return run ? c.json({ artifacts: run.artifacts }) : c.json({ error: "not_found" }, 404);
    },
  }),
  registerApiRoute("/v1/runs/:runId/artifacts/:artifactId", {
    method: "GET",
    handler: async c => {
      const run = await runRepository.get(c.req.param("runId"));
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
      try { return c.json(await rerunE2E(c.get("mastra"), c.req.param("runId"), authenticatedUser(c)?.id), 202); }
      catch (error) { return c.json({ error: "rerun_failed", ...errorBody(error, crypto.randomUUID()) }, 409); }
    },
  }),
  registerApiRoute("/v1/runs/:runId/cancel", {
    method: "POST",
    handler: async c => {
      try { return c.json(await cancelE2ERun(c.get("mastra"), c.req.param("runId"))); }
      catch (error) { return c.json(errorBody(error, crypto.randomUUID()), 409); }
    },
  }),
  registerApiRoute("/v1/runs/:runId/qa-verdict", {
    method: "POST",
    handler: async c => {
      const parsed = QaVerdictSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
      const reviewerId = authenticatedUser(c)?.id ?? parsed.data.reviewerId;
      try { return c.json(await resumeE2EWithVerdict(c.get("mastra"), c.req.param("runId"), { ...parsed.data, reviewerId })); }
      catch (error) { return c.json(errorBody(error, crypto.randomUUID()), 409); }
    },
  }),
  registerApiRoute("/runs/:runId", {
    method: "GET",
    handler: async c => {
      const id = c.req.param("runId");
      const run = await runRepository.get(id);
      if (!run) return c.html("<h1>Run not found</h1>", 404);
      const events = await runRepository.events(id);
      const payload = JSON.stringify({ run, events }).replaceAll("<", "\\u003c");
      return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Qasey Run</title><style>body{font-family:ui-sans-serif,system-ui;background:#0b1020;color:#e9eefc;margin:0;padding:32px}main{max-width:960px;margin:auto}.card{background:#151d33;border:1px solid #293655;border-radius:14px;padding:20px;margin:16px 0}.status,a{color:#7dd3fc}li{margin:8px 0}code{color:#c4b5fd}</style></head><body><main><h1>Qasey E2E Run</h1><div id="app"></div></main><script>const {run,events}=${payload};const app=document.getElementById('app');const card=(title)=>{const d=document.createElement('div');d.className='card';const h=document.createElement('h3');h.textContent=title;d.append(h);app.append(d);return d};const overview=card(run.framework+' · '+run.repository.repository);const status=document.createElement('div');status.className='status';status.textContent=run.status;const code=document.createElement('code');code.textContent=run.id;overview.append(status,code);const timeline=card('Timeline');const tl=document.createElement('ul');for(const e of events){const li=document.createElement('li');li.textContent=e.at+' · '+e.message;tl.append(li)}timeline.append(tl);const artifacts=card('Artifacts');const al=document.createElement('ul');for(const a of run.artifacts){const li=document.createElement('li');const link=document.createElement('a');link.textContent=a.kind+' · '+a.name;link.href='/v1/runs/'+encodeURIComponent(run.id)+'/artifacts/'+encodeURIComponent(a.id);link.target='_blank';li.append(link);al.append(li)}artifacts.append(al);</script></body></html>`);
    },
  }),
];
