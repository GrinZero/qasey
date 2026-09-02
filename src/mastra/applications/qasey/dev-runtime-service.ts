import { randomBytes, randomUUID } from "node:crypto";
import type { MastraServerCache } from "@mastra/core/cache";
import { isLeaseProvider, type EventCallback, type PubSub } from "@mastra/core/events";
import type { Mastra } from "@mastra/core/mastra";
import { z } from "zod";
import { logInfo } from "../../../../packages/adapters/src/index.ts";
import {
  DEV_RUNTIME_ACCEPT_TIMEOUT_MS,
  DEV_RUNTIME_APPROVAL_TTL_MS,
  DEV_RUNTIME_BINDING_TTL_MS,
  DEV_RUNTIME_HEARTBEAT_MS,
  DEV_RUNTIME_JOB_TTL_MS,
  DEV_RUNTIME_PRESENCE_TTL_MS,
  DEV_RUNTIME_RECONNECT_GRACE_MS,
  DevRuntimeClientEventSchema,
  DevRuntimeIdSchema,
  DevRuntimeInstanceIdSchema,
  DevRuntimeJobIdSchema,
  DevRuntimeJobSchema,
  DevRuntimeServerEventSchema,
  hashCapability,
  jobEventTopic,
  runtimeJobTopic,
  secureTokenMatches,
  type DevRuntimeClientEvent,
  type DevRuntimeJob,
  type DevRuntimeServerEvent,
} from "./dev-runtime-protocol.ts";

const PresenceSchema = z.object({
  runtimeId: DevRuntimeIdSchema,
  instanceId: DevRuntimeInstanceIdSchema,
  connectionId: z.uuid(),
  connectedAt: z.iso.datetime(),
  heartbeatAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict();

const BindingSchema = z.object({
  workspaceId: z.string().min(1),
  slackUserId: z.string().min(1),
  runtimeId: DevRuntimeIdSchema,
  expiresAt: z.iso.datetime(),
}).strict();

const ApprovalRecordSchema = z.object({
  approvalId: z.uuid(),
  jobId: z.uuid(),
  runtimeId: DevRuntimeIdSchema,
  workspaceId: z.string().min(1),
  slackUserId: z.string().min(1),
  toolName: z.string().min(1),
  argsSummary: z.string(),
  argsHash: z.string(),
  tokenHash: z.string(),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
  expiresAt: z.iso.datetime(),
}).strict();

export type DevRuntimeBinding = z.infer<typeof BindingSchema> & { online: boolean };
export type DevRuntimeApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export class DevRuntimeTunnelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "DevRuntimeTunnelError";
  }
}

export interface RemoteJobHandlers {
  onPhase?: (event: Extract<DevRuntimeClientEvent, { type: "phase" }>) => void | Promise<void>;
  onProgress?: (event: Extract<DevRuntimeClientEvent, { type: "progress" }>) => void | Promise<void>;
  onToolStarted?: (event: Extract<DevRuntimeClientEvent, { type: "tool_started" }>) => void | Promise<void>;
  onAgentRuntimeEvent?: (event: Extract<DevRuntimeClientEvent, { type: "agent_runtime_event" }>) => void | Promise<void>;
  onApprovalRequested?: (event: Extract<DevRuntimeClientEvent, { type: "approval_requested" }>) => void | Promise<void>;
}

interface TunnelInfrastructure {
  cache: MastraServerCache;
  pubsub: PubSub;
}

export class DevRuntimeTunnelService {
  readonly cache: MastraServerCache;
  readonly pubsub: PubSub;

  constructor(infrastructure: TunnelInfrastructure) {
    this.cache = infrastructure.cache;
    this.pubsub = infrastructure.pubsub;
  }

  async openConnection(input: {
    runtimeId: string;
    instanceId: string;
    send: (event: DevRuntimeServerEvent) => void | Promise<void>;
  }): Promise<() => Promise<void>> {
    const runtimeId = DevRuntimeIdSchema.parse(input.runtimeId);
    const instanceId = DevRuntimeInstanceIdSchema.parse(input.instanceId);
    const connectionId = randomUUID();
    const connectedAt = new Date().toISOString();
    let closed = false;
    let registered = false;
    const refreshPresence = async () => {
      if (closed) return;
      if (registered) {
        const current = await this.presence(runtimeId);
        if (current?.connectionId !== connectionId) return;
      }
      const now = Date.now();
      await this.cache.set(presenceKey(runtimeId), {
        runtimeId,
        instanceId,
        connectionId,
        connectedAt,
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + DEV_RUNTIME_PRESENCE_TTL_MS).toISOString(),
      }, DEV_RUNTIME_PRESENCE_TTL_MS);
      registered = true;
    };
    await refreshPresence();

    const listener: EventCallback = async (raw, ack) => {
      try {
        const current = await this.presence(runtimeId);
        if (!current || current.connectionId !== connectionId) return;
        await input.send(DevRuntimeServerEventSchema.parse(raw.data));
      } finally {
        await ack?.();
      }
    };
    await this.pubsub.subscribe(runtimeJobTopic(runtimeId), listener);
    await input.send({ type: "connected", runtimeId });
    logInfo("dev_runtime.connected", { runtimeId, instanceId });
    const heartbeat = setInterval(() => { void refreshPresence(); }, DEV_RUNTIME_HEARTBEAT_MS);
    heartbeat.unref?.();

    return async () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      await this.pubsub.unsubscribe(runtimeJobTopic(runtimeId), listener);
      const current = await this.presence(runtimeId);
      if (current?.connectionId === connectionId) await this.cache.delete(presenceKey(runtimeId));
      logInfo("dev_runtime.disconnected", { runtimeId, instanceId });
    };
  }

  async isOnline(runtimeId: string): Promise<boolean> {
    return Boolean(await this.presence(DevRuntimeIdSchema.parse(runtimeId)));
  }

  async bind(workspaceId: string, slackUserId: string, runtimeIdInput: string): Promise<DevRuntimeBinding> {
    const runtimeId = DevRuntimeIdSchema.parse(runtimeIdInput);
    if (!await this.isOnline(runtimeId)) {
      throw new DevRuntimeTunnelError("runtime_offline", `Runtime ${runtimeId} 当前不在线。`);
    }
    const leaseProvider = this.requireLeaseProvider();
    const owner = bindingOwner(workspaceId, slackUserId);
    const claimed = await leaseProvider.acquireLease(runtimeClaimKey(runtimeId), owner, DEV_RUNTIME_BINDING_TTL_MS);
    if (!claimed.acquired && claimed.owner !== owner) {
      throw new DevRuntimeTunnelError("runtime_claimed", `Runtime ${runtimeId} 已被其他 Slack 用户绑定。`);
    }

    const previous = await this.readBinding(workspaceId, slackUserId);
    try {
      const expiresAt = new Date(Date.now() + DEV_RUNTIME_BINDING_TTL_MS).toISOString();
      const binding = { workspaceId, slackUserId, runtimeId, expiresAt };
      await this.cache.set(bindingKey(workspaceId, slackUserId), binding, DEV_RUNTIME_BINDING_TTL_MS);
      if (previous && previous.runtimeId !== runtimeId) {
        await leaseProvider.releaseLease(runtimeClaimKey(previous.runtimeId), owner);
      }
      logInfo("dev_runtime.binding.created", { runtimeId, workspaceId, slackUserId });
      return { ...binding, online: true };
    } catch (error) {
      if (previous?.runtimeId !== runtimeId) {
        await leaseProvider.releaseLease(runtimeClaimKey(runtimeId), owner).catch(() => undefined);
      }
      throw error;
    }
  }

  async unbind(workspaceId: string, slackUserId: string): Promise<boolean> {
    const existing = await this.readBinding(workspaceId, slackUserId);
    if (!existing) return false;
    await this.cache.delete(bindingKey(workspaceId, slackUserId));
    await this.requireLeaseProvider().releaseLease(
      runtimeClaimKey(existing.runtimeId),
      bindingOwner(workspaceId, slackUserId),
    );
    logInfo("dev_runtime.binding.removed", { runtimeId: existing.runtimeId, workspaceId, slackUserId });
    return true;
  }

  async bindingFor(workspaceId: string, slackUserId: string): Promise<DevRuntimeBinding | undefined> {
    const binding = await this.readBinding(workspaceId, slackUserId);
    if (!binding) return undefined;
    if (Date.parse(binding.expiresAt) <= Date.now()) {
      await this.unbind(workspaceId, slackUserId);
      return undefined;
    }
    return { ...binding, online: await this.isOnline(binding.runtimeId) };
  }

  async publishClientEvent(input: {
    runtimeId: string;
    instanceId: string;
    jobId: string;
    event: unknown;
  }): Promise<void> {
    const runtimeId = DevRuntimeIdSchema.parse(input.runtimeId);
    const instanceId = DevRuntimeInstanceIdSchema.parse(input.instanceId);
    const jobId = DevRuntimeJobIdSchema.parse(input.jobId);
    const current = await this.presence(runtimeId);
    if (!current || current.instanceId !== instanceId) {
      throw new DevRuntimeTunnelError("stale_runtime_instance", "Runtime connection is no longer current", 409);
    }
    const event = DevRuntimeClientEventSchema.parse(input.event);
    await this.pubsub.publish(jobEventTopic(jobId), {
      type: "qasey.dev-runtime.client-event",
      runId: jobId,
      data: event,
    });
  }

  async runRemoteJob(jobInput: DevRuntimeJob, handlers: RemoteJobHandlers = {}): Promise<unknown> {
    const job = DevRuntimeJobSchema.parse(jobInput);
    if (!await this.isOnline(job.runtimeId)) {
      throw new DevRuntimeTunnelError("runtime_offline", `Runtime ${job.runtimeId} 当前不在线。`);
    }
    const topic = jobEventTopic(job.jobId);
    const dispatchedAt = Date.now();
    let lastSequence = 0;
    let accepted = false;
    let settled = false;
    let acceptTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let presenceTimer: ReturnType<typeof setInterval> | undefined;
    let disconnectedAt: number | undefined;

    return new Promise<unknown>((resolve, reject) => {
      const cleanup = async () => {
        if (acceptTimer) clearTimeout(acceptTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (presenceTimer) clearInterval(presenceTimer);
        await this.pubsub.unsubscribe(topic, listener);
        await this.pubsub.clearTopic(topic);
      };
      const finish = (status: string, action: () => void) => {
        if (settled) return;
        settled = true;
        logInfo("dev_runtime.job.finished", {
          runtimeId: job.runtimeId,
          jobId: job.jobId,
          slackUserId: job.context.actor.id,
          workspaceId: job.delivery.workspaceId,
          status,
          durationMs: Date.now() - dispatchedAt,
        });
        void cleanup().finally(action);
      };
      const listener: EventCallback = async (raw, ack) => {
        try {
          const event = DevRuntimeClientEventSchema.parse(raw.data);
          if (event.sequence <= lastSequence || settled) return;
          lastSequence = event.sequence;
          if (event.type === "accepted") {
            accepted = true;
            if (acceptTimer) clearTimeout(acceptTimer);
            logInfo("dev_runtime.job.accepted", {
              runtimeId: job.runtimeId,
              jobId: job.jobId,
              acceptedLatencyMs: Date.now() - dispatchedAt,
            });
          } else if (event.type === "phase") await handlers.onPhase?.(event);
          else if (event.type === "progress") await handlers.onProgress?.(event);
          else if (event.type === "tool_started") await handlers.onToolStarted?.(event);
          else if (event.type === "agent_runtime_event") await handlers.onAgentRuntimeEvent?.(event);
          else if (event.type === "approval_requested") await handlers.onApprovalRequested?.(event);
          else if (event.type === "completed") finish("completed", () => resolve(event.result));
          else if (event.type === "failed") finish("failed", () => reject(new DevRuntimeTunnelError(event.code, event.message, 502)));
          else if (event.type === "cancelled") finish("cancelled", () => reject(new DevRuntimeTunnelError("runtime_cancelled", "本地 Runtime 已取消任务。", 502)));
        } catch (error) {
          void this.cancelJob(job.runtimeId, job.jobId, "Cloud delivery failed").catch(() => undefined);
          finish("event_delivery_failed", () => reject(error));
        } finally {
          await ack?.();
        }
      };

      void (async () => {
        try {
          await this.pubsub.subscribe(topic, listener);
          await this.pubsub.publish(runtimeJobTopic(job.runtimeId), {
            type: "qasey.dev-runtime.server-event",
            runId: job.jobId,
            data: job,
          });
          logInfo("dev_runtime.job.dispatched", {
            runtimeId: job.runtimeId,
            jobId: job.jobId,
            slackUserId: job.context.actor.id,
            workspaceId: job.delivery.workspaceId,
          });
          acceptTimer = setTimeout(() => {
            if (!accepted) {
              void this.cancelJob(job.runtimeId, job.jobId, "Job acceptance timed out").catch(() => undefined);
              finish("accept_timeout", () => reject(new DevRuntimeTunnelError(
                "runtime_accept_timeout",
                `Runtime ${job.runtimeId} 未在 ${DEV_RUNTIME_ACCEPT_TIMEOUT_MS / 1_000} 秒内接收任务。`,
                504,
              )));
            }
          }, DEV_RUNTIME_ACCEPT_TIMEOUT_MS);
          const remainingMs = Math.max(1, Date.parse(job.deadlineAt) - Date.now());
          deadlineTimer = setTimeout(() => {
            void this.cancelJob(job.runtimeId, job.jobId, "Job deadline exceeded").catch(() => undefined);
            finish("job_timeout", () => reject(new DevRuntimeTunnelError(
              "runtime_job_timeout",
              `Runtime ${job.runtimeId} 执行超时。`,
              504,
            )));
          }, remainingMs);
          let checkingPresence = false;
          presenceTimer = setInterval(() => {
            if (settled || checkingPresence) return;
            checkingPresence = true;
            void this.isOnline(job.runtimeId).then(online => {
              if (online) {
                disconnectedAt = undefined;
                return;
              }
              disconnectedAt ??= Date.now();
              if (Date.now() - disconnectedAt < DEV_RUNTIME_RECONNECT_GRACE_MS) return;
              finish("runtime_disconnected", () => reject(new DevRuntimeTunnelError(
                "runtime_disconnected",
                `Runtime ${job.runtimeId} 在 ${DEV_RUNTIME_RECONNECT_GRACE_MS / 1_000} 秒内未恢复连接。`,
                502,
              )));
            }).catch(error => finish("presence_failed", () => reject(error))).finally(() => {
              checkingPresence = false;
            });
          }, Math.min(DEV_RUNTIME_HEARTBEAT_MS, 5_000));
          presenceTimer.unref?.();
        } catch (error) {
          finish("dispatch_failed", () => reject(error));
        }
      })();
    });
  }

  async createApproval(input: {
    approvalId: string;
    jobId: string;
    runtimeId: string;
    workspaceId: string;
    slackUserId: string;
    toolName: string;
    argsSummary: string;
    argsHash: string;
    deadlineAt: string;
  }): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(24).toString("base64url");
    const expiresAtMs = Math.min(Date.parse(input.deadlineAt), Date.now() + DEV_RUNTIME_APPROVAL_TTL_MS);
    const record = ApprovalRecordSchema.parse({
      approvalId: input.approvalId,
      jobId: input.jobId,
      runtimeId: input.runtimeId,
      workspaceId: input.workspaceId,
      slackUserId: input.slackUserId,
      toolName: input.toolName,
      argsSummary: input.argsSummary,
      argsHash: input.argsHash,
      tokenHash: hashCapability(token),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    await this.cache.set(approvalKey(record.approvalId), record, Math.max(1, expiresAtMs - Date.now()));
    logInfo("dev_runtime.approval.requested", {
      runtimeId: record.runtimeId,
      jobId: record.jobId,
      approvalId: record.approvalId,
      slackUserId: record.slackUserId,
      workspaceId: record.workspaceId,
      toolName: record.toolName,
    });
    return { token, expiresAt: record.expiresAt };
  }

  async attachApprovalMessage(approvalId: string, threadId: string, messageId: string): Promise<void> {
    const parsedApprovalId = z.uuid().parse(approvalId);
    const record = await this.readApproval(parsedApprovalId);
    if (!record) throw new DevRuntimeTunnelError("approval_expired", "Approval is no longer pending", 410);
    await this.cache.set(approvalKey(parsedApprovalId), { ...record, threadId, messageId }, Math.max(1, Date.parse(record.expiresAt) - Date.now()));
  }

  async decideApproval(input: {
    approvalId: string;
    token: string;
    slackUserId: string;
    decision: "approved" | "declined";
  }): Promise<DevRuntimeApprovalRecord> {
    const approvalId = z.uuid().parse(input.approvalId);
    const record = await this.readApproval(approvalId);
    if (!record || Date.parse(record.expiresAt) <= Date.now()) {
      throw new DevRuntimeTunnelError("approval_expired", "Approval is no longer pending", 410);
    }
    if (!secureTokenMatches(hashCapability(input.token), record.tokenHash)) {
      throw new DevRuntimeTunnelError("invalid_approval_token", "Invalid approval capability", 401);
    }
    if (input.slackUserId !== record.slackUserId) {
      throw new DevRuntimeTunnelError("wrong_approver", "Only the user who started this task may decide it", 403);
    }
    const decisionOwner = randomBytes(16).toString("hex");
    const claimed = await this.requireLeaseProvider().acquireLease(
      approvalDecisionKey(record.approvalId),
      decisionOwner,
      DEV_RUNTIME_APPROVAL_TTL_MS,
    );
    if (!claimed.acquired) {
      throw new DevRuntimeTunnelError("approval_already_decided", "Approval was already decided", 409);
    }
    try {
      await this.pubsub.publish(runtimeJobTopic(record.runtimeId), {
        type: "qasey.dev-runtime.server-event",
        runId: record.jobId,
        data: {
          type: "approval_decision",
          approvalId: record.approvalId,
          decision: input.decision,
        } satisfies DevRuntimeServerEvent,
      });
    } catch (error) {
      await this.requireLeaseProvider().releaseLease(approvalDecisionKey(record.approvalId), decisionOwner).catch(() => undefined);
      throw error;
    }
    await this.cache.delete(approvalKey(record.approvalId));
    logInfo("dev_runtime.approval.decided", {
      runtimeId: record.runtimeId,
      jobId: record.jobId,
      approvalId: record.approvalId,
      slackUserId: record.slackUserId,
      decision: input.decision,
    });
    return record;
  }

  async expireApproval(approvalId: string): Promise<DevRuntimeApprovalRecord | undefined> {
    const parsedApprovalId = z.uuid().parse(approvalId);
    const record = await this.readApproval(parsedApprovalId);
    if (record) {
      await this.cache.delete(approvalKey(parsedApprovalId));
      logInfo("dev_runtime.approval.expired", {
        runtimeId: record.runtimeId,
        jobId: record.jobId,
        approvalId: record.approvalId,
        slackUserId: record.slackUserId,
      });
    }
    return record;
  }

  async cancelJob(runtimeId: string, jobId: string, reason: string): Promise<void> {
    const parsedJobId = DevRuntimeJobIdSchema.parse(jobId);
    await this.pubsub.publish(runtimeJobTopic(DevRuntimeIdSchema.parse(runtimeId)), {
      type: "qasey.dev-runtime.server-event",
      runId: parsedJobId,
      data: { type: "cancel", jobId: parsedJobId, reason } satisfies DevRuntimeServerEvent,
    });
  }

  private async presence(runtimeId: string) {
    const parsed = PresenceSchema.safeParse(await this.cache.get(presenceKey(runtimeId)));
    if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()) return undefined;
    return parsed.data;
  }

  private async readBinding(workspaceId: string, slackUserId: string) {
    const parsed = BindingSchema.safeParse(await this.cache.get(bindingKey(workspaceId, slackUserId)));
    return parsed.success ? parsed.data : undefined;
  }

  private async readApproval(approvalId: string) {
    const parsed = ApprovalRecordSchema.safeParse(await this.cache.get(approvalKey(approvalId)));
    return parsed.success ? parsed.data : undefined;
  }

  private requireLeaseProvider() {
    if (!isLeaseProvider(this.pubsub)) {
      throw new DevRuntimeTunnelError("tunnel_registry_unavailable", "Dev Runtime registry requires distributed leases", 503);
    }
    return this.pubsub;
  }
}

const services = new WeakMap<Mastra, DevRuntimeTunnelService>();

export function getDevRuntimeTunnelService(mastra: Mastra): DevRuntimeTunnelService {
  const existing = services.get(mastra);
  if (existing) return existing;
  const service = new DevRuntimeTunnelService({ cache: mastra.getServerCache(), pubsub: mastra.pubsub });
  services.set(mastra, service);
  return service;
}

function presenceKey(runtimeId: string) { return `dev-runtime:presence:${runtimeId}`; }
function bindingKey(workspaceId: string, userId: string) { return `dev-runtime:binding:${workspaceId}:${userId}`; }
function runtimeClaimKey(runtimeId: string) { return `dev-runtime:claim:${runtimeId}`; }
function bindingOwner(workspaceId: string, userId: string) { return `${workspaceId}:${userId}`; }
function approvalKey(approvalId: string) { return `dev-runtime:approval:${approvalId}`; }
function approvalDecisionKey(approvalId: string) { return `dev-runtime:approval-decision:${approvalId}`; }

export const devRuntimeTunnelRetention = {
  jobTtlMs: DEV_RUNTIME_JOB_TTL_MS,
};
