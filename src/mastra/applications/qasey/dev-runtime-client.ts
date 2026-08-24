import { randomBytes, randomUUID } from "node:crypto";
import type { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import type { QaseyConfig } from "../../../../packages/adapters/src/config.ts";
import { devRuntimeTunnelClientEnabled } from "../../../../packages/adapters/src/config.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../../../platform/context/schema.ts";
import { DEFAULT_SLACK_DEV_RUNTIME_COMMAND } from "../../../platform/channels/slack-dev-runtime.ts";
import { runQaseyTaskWorkflow } from "../../workflows/qasey-task-workflow.ts";
import {
  DEV_RUNTIME_APPROVAL_GATE_KEY,
  type DevRuntimeApprovalGate,
} from "./dev-runtime-approval-gate.ts";
import {
  DEV_RUNTIME_JOB_TTL_MS,
  DevRuntimeServerEventSchema,
  type DevRuntimeClientEvent,
  type DevRuntimeJob,
  type DevRuntimeServerEvent,
} from "./dev-runtime-protocol.ts";

interface JobState {
  job: DevRuntimeJob;
  abort: AbortController;
  sequence: number;
}

interface ApprovalWaiter {
  resolve: (decision: "approved" | "declined") => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type DevRuntimeClientEventInput = DevRuntimeClientEvent extends infer TEvent
  ? TEvent extends { sequence: number } ? Omit<TEvent, "sequence"> : never
  : never;

export interface DevRuntimeClientOptions {
  fetch?: typeof fetch;
  log?: Pick<Console, "info" | "warn" | "error">;
  runtimeId?: string;
  instanceId?: string;
}

export class DevRuntimeTunnelClient {
  readonly runtimeId: string;
  readonly instanceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Pick<Console, "info" | "warn" | "error">;
  private readonly activeJobs = new Map<string, JobState>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();
  private readonly seenJobs = new Map<string, number>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private connectionAbort?: AbortController;
  private loop?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly mastra: Mastra,
    private readonly config: QaseyConfig,
    options: DevRuntimeClientOptions = {},
  ) {
    this.runtimeId = options.runtimeId ?? generateRuntimeId();
    this.instanceId = options.instanceId ?? randomUUID();
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? console;
  }

  start(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.connectLoop();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.connectionAbort?.abort();
    this.abortActiveJobs("Local development runtime stopped");
    await this.loop?.catch(() => undefined);
  }

  private async connectLoop(): Promise<void> {
    let retryMs = 500;
    while (!this.stopped) {
      this.connectionAbort = new AbortController();
      try {
        await this.consumeConnection(this.connectionAbort.signal);
        retryMs = 500;
      } catch (error) {
        if (!this.stopped) this.log.warn(`Dev Runtime tunnel disconnected: ${errorMessage(error)}`);
      } finally {
        this.abortActiveJobs("Dev Runtime tunnel connection was lost");
      }
      if (this.stopped) break;
      await abortableDelay(retryMs, this.connectionAbort.signal).catch(() => undefined);
      retryMs = Math.min(15_000, retryMs * 2);
    }
  }

  private async consumeConnection(signal: AbortSignal): Promise<void> {
    const baseUrl = this.config.QASEY_DEV_TUNNEL_BASE_URL!.replace(/\/$/u, "");
    const url = new URL(`${baseUrl}/v1/dev-runtimes/events`);
    url.searchParams.set("runtimeId", this.runtimeId);
    url.searchParams.set("instanceId", this.instanceId);
    const response = await this.fetchImpl(url, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${this.config.QASEY_DEV_TUNNEL_TOKEN}`,
      },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`Tunnel server returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!this.stopped) {
      const next = await reader.read();
      if (next.done) throw new Error("Tunnel server closed the event stream");
      buffer += decoder.decode(next.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n")
          .filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart())
          .join("\n");
        if (data) await this.handleServerEvent(DevRuntimeServerEventSchema.parse(JSON.parse(data)));
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  private async handleServerEvent(event: DevRuntimeServerEvent): Promise<void> {
    if (event.type === "connected") {
      this.log.info(`Local Slack runtime: ${this.runtimeId}`);
      this.log.info(`Bind with your Slack App command: <command> bind ${this.runtimeId} (default: ${DEFAULT_SLACK_DEV_RUNTIME_COMMAND})`);
      return;
    }
    if (event.type === "job") {
      const cutoff = Date.now() - DEV_RUNTIME_JOB_TTL_MS;
      for (const [jobId, seenAt] of this.seenJobs) {
        if (seenAt < cutoff) this.seenJobs.delete(jobId);
      }
      if (this.seenJobs.has(event.jobId)) return;
      this.seenJobs.set(event.jobId, Date.now());
      const state: JobState = { job: event, abort: new AbortController(), sequence: 0 };
      this.activeJobs.set(event.jobId, state);
      await this.postEvent(state, { type: "accepted" });
      const previous = this.sessionQueues.get(event.context.sessionId) ?? Promise.resolve();
      const queued = previous.catch(() => undefined).then(() => this.executeJob(state));
      this.sessionQueues.set(event.context.sessionId, queued);
      void queued.finally(() => {
        if (this.sessionQueues.get(event.context.sessionId) === queued) {
          this.sessionQueues.delete(event.context.sessionId);
        }
      });
      return;
    }
    if (event.type === "approval_decision") {
      const waiter = this.approvalWaiters.get(event.approvalId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.approvalWaiters.delete(event.approvalId);
      waiter.resolve(event.decision);
      return;
    }
    const state = this.activeJobs.get(event.jobId);
    state?.abort.abort(new Error(event.reason));
  }

  private async executeJob(state: JobState): Promise<void> {
    const { job } = state;
    const requestContext = new RequestContext<any>();
    requestContext.set("requestId", job.context.requestId);
    requestContext.set("applicationId", "qasey");
    requestContext.set("tenantId", job.context.actor.tenantId);
    requestContext.set("userId", job.context.actor.id);
    requestContext.set("ingressSource", "dev-runtime-tunnel:slack");
    requestContext.set("identity", {
      userId: job.context.actor.id,
      tenantId: job.context.actor.tenantId,
      roles: ["channel-user"],
      service: false,
    });
    requestContext.set("sessionId", job.context.sessionId);
    if (job.delivery.installationId) requestContext.set("integrationId", job.delivery.installationId);
    requestContext.set(MASTRA_RESOURCE_ID_KEY, job.resourceId);
    requestContext.set(MASTRA_THREAD_ID_KEY, job.threadId);
    const gate: DevRuntimeApprovalGate = {
      request: approval => this.requestApproval(state, approval),
    };
    requestContext.set(DEV_RUNTIME_APPROVAL_GATE_KEY, gate);
    try {
      const result = await runQaseyTaskWorkflow(this.mastra, job.context, {
        requestContext,
        abortSignal: state.abort.signal,
        events: {
          onPhase: async ({ runId, phase }) => this.postEvent(state, { type: "phase", runId, phase }),
          onAgentRuntimeEvent: async event => this.postEvent(state, { type: "agent_runtime_event", event }),
          onAgentProgress: async ({ runId, ...report }) => this.postEvent(state, { type: "progress", runId, report }),
          onToolStart: async ({ runId, toolName }) => this.postEvent(state, { type: "tool_started", runId, toolName }),
        },
      });
      await this.postEvent(state, { type: "completed", result });
    } catch (error) {
      if (state.abort.signal.aborted) {
        await this.postEvent(state, { type: "cancelled" }).catch(() => undefined);
      } else {
        this.log.error(`Local Runtime job ${job.jobId} failed: ${errorMessage(error)}`);
        await this.postEvent(state, {
          type: "failed",
          code: "local_runtime_failed",
          message: "本地 Runtime 执行失败，请开发者查看本地日志。",
        }).catch(() => undefined);
      }
    } finally {
      requestContext.delete(DEV_RUNTIME_APPROVAL_GATE_KEY);
      this.activeJobs.delete(job.jobId);
    }
  }

  private async requestApproval(
    state: JobState,
    input: { toolName: string; argsSummary: string; argsHash: string },
  ): Promise<"approved" | "declined"> {
    const approvalId = randomUUID();
    await this.postEvent(state, { type: "approval_requested", approvalId, ...input });
    return new Promise<"approved" | "declined">((resolve, reject) => {
      const remainingMs = Math.max(1, Date.parse(state.job.deadlineAt) - Date.now());
      const timer = setTimeout(() => {
        this.approvalWaiters.delete(approvalId);
        reject(new Error("Slack tool approval timed out"));
      }, Math.min(10 * 60_000, remainingMs));
      const abort = () => {
        clearTimeout(timer);
        this.approvalWaiters.delete(approvalId);
        reject(new Error("Job was cancelled while waiting for approval"));
      };
      state.abort.signal.addEventListener("abort", abort, { once: true });
      this.approvalWaiters.set(approvalId, {
        timer,
        resolve: decision => {
          state.abort.signal.removeEventListener("abort", abort);
          resolve(decision);
        },
        reject,
      });
    });
  }

  private async postEvent(
    state: JobState,
    event: DevRuntimeClientEventInput,
  ): Promise<void> {
    const sequence = ++state.sequence;
    const baseUrl = this.config.QASEY_DEV_TUNNEL_BASE_URL!.replace(/\/$/u, "");
    const response = await this.fetchImpl(
      `${baseUrl}/v1/dev-runtimes/${encodeURIComponent(this.runtimeId)}/jobs/${encodeURIComponent(state.job.jobId)}/events`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.QASEY_DEV_TUNNEL_TOKEN}`,
          "content-type": "application/json",
          "x-qasey-runtime-instance": this.instanceId,
        },
        body: JSON.stringify({ ...event, sequence }),
        signal: state.abort.signal,
      },
    );
    if (!response.ok) throw new Error(`Tunnel event POST returned HTTP ${response.status}`);
  }

  private abortActiveJobs(reason: string): void {
    for (const state of this.activeJobs.values()) state.abort.abort(new Error(reason));
    for (const [approvalId, waiter] of this.approvalWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
      this.approvalWaiters.delete(approvalId);
    }
  }
}

export function startDevRuntimeTunnelClient(
  mastra: Mastra,
  config: QaseyConfig,
): DevRuntimeTunnelClient | undefined {
  if (config.NODE_ENV !== "development" || config.QASEY_DEV_TUNNEL_ENABLED !== true) return undefined;
  if (!devRuntimeTunnelClientEnabled(config)) {
    console.warn("Dev Runtime tunnel is enabled but QASEY_DEV_TUNNEL_BASE_URL or QASEY_DEV_TUNNEL_TOKEN is missing; Slack routing is unavailable.");
    return undefined;
  }
  const client = new DevRuntimeTunnelClient(mastra, config);
  client.start();
  return client;
}

function generateRuntimeId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `local-${Array.from(randomBytes(8), byte => alphabet[byte % alphabet.length]).join("")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
