import type { Message, QueueEntry } from "chat";
import { describe, expect, it } from "vitest";
import {
  InMemorySlackIngressStore,
  SlackIngressRetryableError,
  SlackIngressStateAdapter,
  slackDeliveryId,
} from "../../src/platform/channels/slack-ingress-state.ts";
import { createQaseySlackChannelConfig } from "../../src/mastra/applications/qasey/channels.ts";

function state(
  store: InMemorySlackIngressStore,
  options: { visibilityTimeoutMs?: number } = {},
): SlackIngressStateAdapter {
  return new SlackIngressStateAdapter({
    keyPrefix: "qasey:test:slack-ingress",
    store,
    heartbeat: false,
    ...options,
  });
}

function queueEntry(messageId: string): QueueEntry {
  return {
    enqueuedAt: Date.now(),
    expiresAt: Date.now() + 90_000,
    message: { id: messageId } as Message,
  };
}

describe("Slack distributed ingress ownership", () => {
  it("gives a delivery to only one replica and reclaims it after visibility timeout", async () => {
    let now = 1_000;
    const store = new InMemorySlackIngressStore(() => now);
    const replicaA = state(store, { visibilityTimeoutMs: 100 });
    const replicaB = state(store, { visibilityTimeoutMs: 100 });

    const first = await replicaA.claimDelivery("slack:T1:171.001", "171.001");
    const concurrent = await replicaB.claimDelivery("slack:T1:171.001", "171.001");

    expect(first.status).toBe("claimed");
    expect(concurrent).toMatchObject({ status: "in-flight", retryable: true });

    now += 101;
    const reclaimed = await replicaB.claimDelivery("slack:T1:171.001", "171.001");
    expect(reclaimed.status).toBe("claimed");
    if (first.status !== "claimed" || reclaimed.status !== "claimed") throw new Error("expected claims");

    expect(await replicaA.ackDelivery(first.claim)).toBe(false);
    expect(await replicaB.ackDelivery(reclaimed.claim)).toBe(true);
    await expect(replicaA.claimDelivery("slack:T1:171.001", "171.001"))
      .resolves.toMatchObject({ status: "duplicate", retryable: false });
  });

  it("releases a failed claim so another replica can retry immediately", async () => {
    const store = new InMemorySlackIngressStore();
    const replicaA = state(store);
    const replicaB = state(store);
    const first = await replicaA.claimDelivery("slack:T1:172.002", "172.002");
    if (first.status !== "claimed") throw new Error("expected claim");

    expect(await replicaA.retryDelivery(first.claim)).toBe(true);
    await expect(replicaB.claimDelivery("slack:T1:172.002", "172.002"))
      .resolves.toMatchObject({ status: "claimed", retryable: false });
  });

  it("shares Chat thread locks and pending messages between replicas", async () => {
    const store = new InMemorySlackIngressStore();
    const replicaA = state(store);
    const replicaB = state(store);

    const owner = await replicaA.acquireLock("slack:C1:thread", 30_000);
    expect(owner).not.toBeNull();
    await expect(replicaB.acquireLock("slack:C1:thread", 30_000)).resolves.toBeNull();

    await replicaA.enqueue("slack:C1:thread", queueEntry("queued-on-a"), 10);
    expect((await replicaB.dequeue("slack:C1:thread"))?.message.id).toBe("queued-on-a");

    if (!owner) throw new Error("expected lock owner");
    await replicaA.releaseLock(owner);
    await expect(replicaB.acquireLock("slack:C1:thread", 30_000)).resolves.not.toBeNull();
  });

  it("never evicts an older queued message and makes overload explicitly retryable", async () => {
    const store = new InMemorySlackIngressStore();
    const adapter = state(store);
    await adapter.setIfNotExists("dedupe:slack:old", true, 60_000);
    await adapter.enqueue("slack:C1:thread", queueEntry("old"), 1);
    await adapter.setIfNotExists("dedupe:slack:new", true, 60_000);

    const rejected = adapter.enqueue("slack:C1:thread", queueEntry("new"), 1);
    await expect(rejected).rejects.toMatchObject({
      name: "SlackIngressRetryableError",
      code: "SLACK_INGRESS_OVERLOADED",
      deliveryId: "new",
      retryable: true,
      status: 503,
    });
    await expect(rejected).rejects.toBeInstanceOf(SlackIngressRetryableError);

    expect(await adapter.get("dedupe:slack:new")).toBeNull();
    expect((await adapter.dequeue("slack:C1:thread"))?.message.id).toBe("old");
  });

  it("uses a stable workspace or installation scoped delivery id", () => {
    expect(slackDeliveryId({ workspaceId: "T1", messageId: "173.003" }))
      .toBe("slack:T1:173.003");
    expect(slackDeliveryId({ installationId: "install-1", workspaceId: "T1", messageId: "173.003" }))
      .toBe("slack:install-1:173.003");
  });

  it("wires shared state in distributed-style configs while standalone never drops an older entry", () => {
    const sharedState = state(new InMemorySlackIngressStore());
    const distributed = createQaseySlackChannelConfig({
      botToken: "fixture-slack-bot-token",
      signingSecret: "fixture-slack-signing-secret",
      ingressState: sharedState,
    });
    const standalone = createQaseySlackChannelConfig({
      botToken: "fixture-slack-bot-token",
      signingSecret: "fixture-slack-signing-secret",
    });

    expect(distributed.state).toBe(sharedState);
    expect(distributed.chatOptions?.concurrency).toMatchObject({ onQueueFull: "drop-newest" });
    expect(standalone.state).toBeUndefined();
    expect(standalone.chatOptions?.concurrency).toMatchObject({ onQueueFull: "drop-newest" });
  });
});
