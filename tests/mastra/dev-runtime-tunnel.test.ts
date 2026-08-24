import { InMemoryServerCache } from "@mastra/core/cache";
import { EventEmitterPubSub } from "@mastra/core/events";
import { describe, expect, it, vi } from "vitest";
import {
  DevRuntimeTunnelError,
  DevRuntimeTunnelService,
} from "../../src/mastra/applications/qasey/dev-runtime-service.ts";
import type { DevRuntimeJob, DevRuntimeServerEvent } from "../../src/mastra/applications/qasey/dev-runtime-protocol.ts";

const runtimeId = "local-ABCDEFG2";
const instanceId = "00000000-0000-4000-8000-000000000001";

function createService() {
  return new DevRuntimeTunnelService({
    cache: new InMemoryServerCache({ ttlMs: 60_000 }),
    pubsub: new EventEmitterPubSub(),
  });
}

function job(): DevRuntimeJob {
  return {
    type: "job",
    jobId: "00000000-0000-4000-8000-000000000002",
    runtimeId,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    context: {
      requestId: "slack:message-1",
      channel: "slack",
      sessionId: "session-1",
      chatInput: "hello",
      actor: { id: "U1", tenantId: "T1" },
      source: { channelId: "C1", threadTs: "1.1" },
      attachments: [],
    },
    resourceId: "resource-1",
    threadId: "thread-1",
    delivery: { workspaceId: "T1" },
  };
}

describe("DevRuntimeTunnelService", () => {
  it("binds one Slack user to an online runtime and preserves an offline binding", async () => {
    const service = createService();
    const close = await service.openConnection({ runtimeId, instanceId, send: vi.fn() });

    const binding = await service.bind("T1", "U1", runtimeId);
    expect(binding).toMatchObject({ runtimeId, online: true });
    await expect(service.bind("T1", "U2", runtimeId)).rejects.toMatchObject({ code: "runtime_claimed" });

    await close();
    await expect(service.bindingFor("T1", "U1")).resolves.toMatchObject({ runtimeId, online: false });
    await expect(service.unbind("T1", "U1")).resolves.toBe(true);
    await expect(service.bindingFor("T1", "U1")).resolves.toBeUndefined();
  });

  it("routes a job and ordered progress/result events across the shared pubsub", async () => {
    const service = createService();
    const progress = vi.fn();
    const runtimeEvent = vi.fn();
    const close = await service.openConnection({
      runtimeId,
      instanceId,
      send: async event => {
        if (event.type !== "job") return;
        await service.publishClientEvent({ runtimeId, instanceId, jobId: event.jobId, event: { type: "accepted", sequence: 1 } });
        await service.publishClientEvent({
          runtimeId,
          instanceId,
          jobId: event.jobId,
          event: {
            type: "progress",
            sequence: 2,
            runId: "run-1",
            report: {
              milestone: "reading",
              title: "Reading requirement",
              detail: "Collecting context",
              status: "working",
              sequence: 1,
              occurredAt: new Date().toISOString(),
            },
          },
        });
        await service.publishClientEvent({
          runtimeId,
          instanceId,
          jobId: event.jobId,
          event: {
            type: "agent_runtime_event",
            sequence: 3,
            event: { type: "step-start", runId: "run-1", step: 1 },
          },
        });
        await service.publishClientEvent({
          runtimeId,
          instanceId,
          jobId: event.jobId,
          event: { type: "completed", sequence: 4, result: { text: "local result" } },
        });
      },
    });

    await expect(service.runRemoteJob(job(), { onProgress: progress, onAgentRuntimeEvent: runtimeEvent })).resolves.toEqual({ text: "local result" });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(runtimeEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_runtime_event" }));
    await close();
  });

  it("does not let an old reconnect cleanup remove the current connection", async () => {
    vi.useFakeTimers();
    try {
      const service = createService();
      const closeOld = await service.openConnection({ runtimeId, instanceId, send: vi.fn() });
      const closeCurrent = await service.openConnection({ runtimeId, instanceId, send: vi.fn() });

      await vi.advanceTimersByTimeAsync(15_000);
      await closeOld();
      await expect(service.isOnline(runtimeId)).resolves.toBe(true);
      await expect(service.bind("T1", "U1", runtimeId)).resolves.toMatchObject({ online: true });

      await closeCurrent();
      await expect(service.isOnline(runtimeId)).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails an accepted job when its runtime disconnects", async () => {
    vi.useFakeTimers();
    try {
      const service = createService();
      const close = await service.openConnection({
        runtimeId,
        instanceId,
        send: async event => {
          if (event.type === "job") {
            await service.publishClientEvent({
              runtimeId,
              instanceId,
              jobId: event.jobId,
              event: { type: "accepted", sequence: 1 },
            });
          }
        },
      });
      const result = service.runRemoteJob(job());
      const rejection = expect(result).rejects.toMatchObject({ code: "runtime_disconnected" });
      await vi.advanceTimersByTimeAsync(1);
      await close();
      await vi.advanceTimersByTimeAsync(5_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects stale instances and enforces single-use, same-user approvals", async () => {
    const service = createService();
    const received: DevRuntimeServerEvent[] = [];
    const close = await service.openConnection({ runtimeId, instanceId, send: event => { received.push(event); } });

    await expect(service.publishClientEvent({
      runtimeId,
      instanceId: "00000000-0000-4000-8000-000000000099",
      jobId: job().jobId,
      event: { type: "accepted", sequence: 1 },
    })).rejects.toMatchObject({ code: "stale_runtime_instance" });

    const approval = await service.createApproval({
      approvalId: "00000000-0000-4000-8000-000000000003",
      jobId: job().jobId,
      runtimeId,
      workspaceId: "T1",
      slackUserId: "U1",
      toolName: "qa_experience_upsert",
      argsSummary: "{}",
      argsHash: "a".repeat(64),
      deadlineAt: job().deadlineAt,
    });
    await expect(service.decideApproval({
      approvalId: "00000000-0000-4000-8000-000000000003",
      token: approval.token,
      slackUserId: "U2",
      decision: "approved",
    })).rejects.toMatchObject({ code: "wrong_approver" });
    await service.decideApproval({
      approvalId: "00000000-0000-4000-8000-000000000003",
      token: approval.token,
      slackUserId: "U1",
      decision: "approved",
    });
    expect(received).toContainEqual(expect.objectContaining({
      type: "approval_decision",
      decision: "approved",
    }));
    await expect(service.decideApproval({
      approvalId: "00000000-0000-4000-8000-000000000003",
      token: approval.token,
      slackUserId: "U1",
      decision: "approved",
    })).rejects.toBeInstanceOf(DevRuntimeTunnelError);
    await close();
  });
});
