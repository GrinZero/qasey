import { describe, expect, it } from "vitest";
import { createTriggerEnvelope, InMemoryTriggerQueue, normalizeApiRequest } from "../../packages/domain/src/index.ts";

describe("durable queue contract", () => {
  it("deduplicates external events", async () => {
    const queue = new InMemoryTriggerQueue();
    const request = normalizeApiRequest({ requestId: "r1", sessionId: "s1", chatInput: "review", actorId: "u1" });
    const envelope = createTriggerEnvelope({ request, source: "api", eventType: "manual" });
    await expect(queue.enqueue(envelope, request)).resolves.toBe(true);
    await expect(queue.enqueue(envelope, request)).resolves.toBe(false);
    await expect(queue.claim("worker")).resolves.toMatchObject({ attempts: 1, request: { requestId: "r1" } });
  });

  it("heartbeats and completes only for the worker that owns the lease", async () => {
    const queue = new InMemoryTriggerQueue();
    const request = normalizeApiRequest({ requestId: "r2", sessionId: "s2", chatInput: "review", actorId: "u2" });
    const envelope = createTriggerEnvelope({ request, source: "api", eventType: "manual" });
    await queue.enqueue(envelope, request);
    const job = await queue.claim("worker-a");

    expect(job).toBeDefined();
    await expect(queue.heartbeat(job!.id, "worker-b")).resolves.toBe(false);
    await expect(queue.complete(job!.id, "worker-b")).resolves.toBe(false);
    await expect(queue.heartbeat(job!.id, "worker-a")).resolves.toBe(true);
    await expect(queue.complete(job!.id, "worker-a")).resolves.toBe(true);
    await expect(queue.heartbeat(job!.id, "worker-a")).resolves.toBe(false);
  });
});
