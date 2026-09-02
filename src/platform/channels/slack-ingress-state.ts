import Redis from "ioredis";
import type { Lock, QueueEntry, StateAdapter } from "chat";

const DEFAULT_VISIBILITY_TIMEOUT_MS = 90_000;
const DEFAULT_COMPLETION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;

export interface SlackIngressRedisOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: boolean;
  tlsServername?: string;
  keyPrefix: string;
  onQueueDepth?(threadId: string, depth: number): void;
  onQueueOverload?(threadId: string): void;
}

export interface SlackIngressStateOptions {
  keyPrefix: string;
  store: SlackIngressSharedStore;
  visibilityTimeoutMs?: number;
  completionTtlMs?: number;
  retryAfterMs?: number;
  /** Tests can disable real timers and advance the shared store's clock instead. */
  heartbeat?: boolean;
  onQueueDepth?(threadId: string, depth: number): void;
  onQueueOverload?(threadId: string): void;
}

export interface SlackDeliveryClaim {
  deliveryId: string;
  messageId: string;
  token: string;
}

export type SlackDeliveryClaimResult =
  | { status: "claimed"; claim: SlackDeliveryClaim; retryable: false }
  | { status: "duplicate"; retryable: false }
  | { status: "in-flight"; retryable: true; retryAfterMs: number };

export class SlackIngressRetryableError extends Error {
  readonly retryable = true;
  readonly status = 503;

  constructor(
    message: string,
    readonly code: "SLACK_INGRESS_BUSY" | "SLACK_INGRESS_OVERLOADED",
    readonly deliveryId: string,
    readonly retryAfterMs = DEFAULT_RETRY_AFTER_MS,
  ) {
    super(message);
    this.name = "SlackIngressRetryableError";
  }
}

export interface SlackIngressCoordinator {
  claimDelivery(deliveryId: string, messageId: string): Promise<SlackDeliveryClaimResult>;
  ackDelivery(claim: SlackDeliveryClaim): Promise<boolean>;
  retryDelivery(claim: SlackDeliveryClaim): Promise<boolean>;
}

type SharedClaimResult = "claimed" | "duplicate" | "in-flight";

/**
 * Atomic storage contract used by the Chat StateAdapter and delivery leases.
 * Redis is the production implementation; the in-memory implementation makes
 * the ownership rules deterministic in focused tests.
 */
export interface SlackIngressSharedStore {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlMs?: number): Promise<boolean>;
  delete(key: string): Promise<void>;
  compareAndDelete(key: string, expected: string): Promise<boolean>;
  compareAndExpire(key: string, expected: string, ttlMs: number): Promise<boolean>;
  appendToList(key: string, value: string, maxLength?: number, ttlMs?: number): Promise<void>;
  getList(key: string): Promise<string[]>;
  enqueue(key: string, value: string, maxSize: number, ttlMs: number): Promise<{ accepted: boolean; depth: number }>;
  dequeue(key: string): Promise<string | null>;
  queueDepth(key: string): Promise<number>;
  claimDelivery(completedKey: string, leaseKey: string, token: string, visibilityTimeoutMs: number): Promise<SharedClaimResult>;
  completeDelivery(completedKey: string, leaseKey: string, token: string, completionTtlMs: number): Promise<boolean>;
  retryDelivery(leaseKey: string, token: string): Promise<boolean>;
}

interface ExpiringValue<T> {
  value: T;
  expiresAt?: number;
}

/** Process-memory backend for deterministic tests and standalone utilities. */
export class InMemorySlackIngressStore implements SlackIngressSharedStore {
  private readonly values = new Map<string, ExpiringValue<string>>();
  private readonly lists = new Map<string, ExpiringValue<string[]>>();

  constructor(private readonly now: () => number = Date.now) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async get(key: string): Promise<string | null> {
    return this.liveValue(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.values.set(key, { value, ...(ttlMs ? { expiresAt: this.now() + ttlMs } : {}) });
  }

  async setIfAbsent(key: string, value: string, ttlMs?: number): Promise<boolean> {
    if (this.liveValue(key)) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.lists.delete(key);
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    const current = this.liveValue(key);
    if (!current || current.value !== expected) return false;
    this.values.delete(key);
    return true;
  }

  async compareAndExpire(key: string, expected: string, ttlMs: number): Promise<boolean> {
    const current = this.liveValue(key);
    if (!current || current.value !== expected) return false;
    current.expiresAt = this.now() + ttlMs;
    return true;
  }

  async appendToList(key: string, value: string, maxLength?: number, ttlMs?: number): Promise<void> {
    const list = this.liveList(key)?.value ?? [];
    list.push(value);
    if (maxLength && list.length > maxLength) list.splice(0, list.length - maxLength);
    this.lists.set(key, { value: list, ...(ttlMs ? { expiresAt: this.now() + ttlMs } : {}) });
  }

  async getList(key: string): Promise<string[]> {
    return [...(this.liveList(key)?.value ?? [])];
  }

  async enqueue(key: string, value: string, maxSize: number, ttlMs: number): Promise<{ accepted: boolean; depth: number }> {
    const list = this.liveList(key)?.value ?? [];
    if (list.length >= maxSize) return { accepted: false, depth: list.length };
    list.push(value);
    this.lists.set(key, { value: list, expiresAt: this.now() + ttlMs });
    return { accepted: true, depth: list.length };
  }

  async dequeue(key: string): Promise<string | null> {
    const current = this.liveList(key);
    if (!current) return null;
    const value = current.value.shift() ?? null;
    if (current.value.length === 0) this.lists.delete(key);
    return value;
  }

  async queueDepth(key: string): Promise<number> {
    return this.liveList(key)?.value.length ?? 0;
  }

  async claimDelivery(
    completedKey: string,
    leaseKey: string,
    token: string,
    visibilityTimeoutMs: number,
  ): Promise<SharedClaimResult> {
    if (this.liveValue(completedKey)) return "duplicate";
    if (this.liveValue(leaseKey)) return "in-flight";
    await this.set(leaseKey, token, visibilityTimeoutMs);
    return "claimed";
  }

  async completeDelivery(
    completedKey: string,
    leaseKey: string,
    token: string,
    completionTtlMs: number,
  ): Promise<boolean> {
    const lease = this.liveValue(leaseKey);
    if (!lease || lease.value !== token) return false;
    this.values.delete(leaseKey);
    await this.set(completedKey, "1", completionTtlMs);
    return true;
  }

  async retryDelivery(leaseKey: string, token: string): Promise<boolean> {
    return this.compareAndDelete(leaseKey, token);
  }

  private liveValue(key: string): ExpiringValue<string> | undefined {
    const value = this.values.get(key);
    if (value?.expiresAt !== undefined && value.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    return value;
  }

  private liveList(key: string): ExpiringValue<string[]> | undefined {
    const value = this.lists.get(key);
    if (value?.expiresAt !== undefined && value.expiresAt <= this.now()) {
      this.lists.delete(key);
      return undefined;
    }
    return value;
  }
}

const COMPARE_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0`;

const COMPARE_EXPIRE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

const ENQUEUE_SCRIPT = `
local depth = redis.call('LLEN', KEYS[1])
if depth >= tonumber(ARGV[2]) then
  return {0, depth}
end
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return {1, depth + 1}`;

const CLAIM_DELIVERY_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 2
end
if redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2], 'NX') then
  return 1
end
return 0`;

const COMPLETE_DELIVERY_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], '1', 'PX', ARGV[2])
redis.call('DEL', KEYS[2])
return 1`;

class RedisSlackIngressStore implements SlackIngressSharedStore {
  constructor(private readonly client: Redis) {}

  async connect(): Promise<void> {
    if (this.client.status === "wait") await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client.status === "ready") await this.client.quit();
    else this.client.disconnect();
  }

  async get(key: string): Promise<string | null> { return this.client.get(key); }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs) await this.client.set(key, value, "PX", ttlMs);
    else await this.client.set(key, value);
  }

  async setIfAbsent(key: string, value: string, ttlMs?: number): Promise<boolean> {
    const result = ttlMs
      ? await this.client.set(key, value, "PX", ttlMs, "NX")
      : await this.client.set(key, value, "NX");
    return result === "OK";
  }

  async delete(key: string): Promise<void> { await this.client.del(key); }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    return Number(await this.client.eval(COMPARE_DELETE_SCRIPT, 1, key, expected)) === 1;
  }

  async compareAndExpire(key: string, expected: string, ttlMs: number): Promise<boolean> {
    return Number(await this.client.eval(COMPARE_EXPIRE_SCRIPT, 1, key, expected, ttlMs)) === 1;
  }

  async appendToList(key: string, value: string, maxLength?: number, ttlMs?: number): Promise<void> {
    const pipeline = this.client.multi().rpush(key, value);
    if (maxLength) pipeline.ltrim(key, -maxLength, -1);
    if (ttlMs) pipeline.pexpire(key, ttlMs);
    await pipeline.exec();
  }

  async getList(key: string): Promise<string[]> { return this.client.lrange(key, 0, -1); }

  async enqueue(key: string, value: string, maxSize: number, ttlMs: number): Promise<{ accepted: boolean; depth: number }> {
    const raw = await this.client.eval(ENQUEUE_SCRIPT, 1, key, value, maxSize, ttlMs);
    const [accepted, depth] = raw as [number | string, number | string];
    return { accepted: Number(accepted) === 1, depth: Number(depth) };
  }

  async dequeue(key: string): Promise<string | null> { return this.client.lpop(key); }
  async queueDepth(key: string): Promise<number> { return this.client.llen(key); }

  async claimDelivery(
    completedKey: string,
    leaseKey: string,
    token: string,
    visibilityTimeoutMs: number,
  ): Promise<SharedClaimResult> {
    const result = Number(await this.client.eval(
      CLAIM_DELIVERY_SCRIPT,
      2,
      completedKey,
      leaseKey,
      token,
      visibilityTimeoutMs,
    ));
    return result === 1 ? "claimed" : result === 2 ? "duplicate" : "in-flight";
  }

  async completeDelivery(
    completedKey: string,
    leaseKey: string,
    token: string,
    completionTtlMs: number,
  ): Promise<boolean> {
    return Number(await this.client.eval(
      COMPLETE_DELIVERY_SCRIPT,
      2,
      completedKey,
      leaseKey,
      token,
      completionTtlMs,
    )) === 1;
  }

  async retryDelivery(leaseKey: string, token: string): Promise<boolean> {
    return this.compareAndDelete(leaseKey, token);
  }
}

/** Redis-backed shared Chat state plus explicit delivery lease lifecycle. */
export class SlackIngressStateAdapter implements StateAdapter, SlackIngressCoordinator {
  private readonly prefix: string;
  private readonly visibilityTimeoutMs: number;
  private readonly completionTtlMs: number;
  private readonly retryAfterMs: number;
  private readonly heartbeat: boolean;
  private readonly lockHeartbeats = new Map<string, ReturnType<typeof setInterval>>();
  private readonly deliveryHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly options: SlackIngressStateOptions) {
    this.prefix = options.keyPrefix.replace(/:+$/u, "");
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
    this.completionTtlMs = options.completionTtlMs ?? DEFAULT_COMPLETION_TTL_MS;
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.heartbeat = options.heartbeat ?? true;
  }

  async connect(): Promise<void> { await this.options.store.connect(); }

  async disconnect(): Promise<void> {
    for (const timer of this.lockHeartbeats.values()) clearInterval(timer);
    for (const timer of this.deliveryHeartbeats.values()) clearInterval(timer);
    this.lockHeartbeats.clear();
    this.deliveryHeartbeats.clear();
    await this.options.store.disconnect();
  }

  async subscribe(threadId: string): Promise<void> { await this.set(`subscription:${threadId}`, true); }
  async unsubscribe(threadId: string): Promise<void> { await this.delete(`subscription:${threadId}`); }
  async isSubscribed(threadId: string): Promise<boolean> { return (await this.get(`subscription:${threadId}`)) === true; }

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.options.store.get(this.key("value", key));
    return value === null ? null : JSON.parse(value) as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    // Slack marks an event delivered before message admission. Persisting that
    // early marker would suppress Slack's retry after a full queue. The stable
    // message delivery id below is the authoritative dedupe record instead.
    if (key.startsWith("slack:event-delivered:")) return;
    await this.options.store.set(this.key("value", key), JSON.stringify(value), ttlMs);
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return this.options.store.setIfAbsent(this.key("value", key), JSON.stringify(value), ttlMs);
  }

  async delete(key: string): Promise<void> { await this.options.store.delete(this.key("value", key)); }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    await this.options.store.appendToList(
      this.key("list", key),
      JSON.stringify(value),
      options?.maxLength,
      options?.ttlMs,
    );
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    return (await this.options.store.getList(this.key("list", key))).map(value => JSON.parse(value) as T);
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const token = crypto.randomUUID();
    const acquired = await this.options.store.setIfAbsent(this.key("lock", threadId), token, ttlMs);
    if (!acquired) return null;
    const lock = { threadId, token, expiresAt: Date.now() + ttlMs };
    this.startLockHeartbeat(lock, ttlMs);
    return lock;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const extended = await this.options.store.compareAndExpire(this.key("lock", lock.threadId), lock.token, ttlMs);
    if (extended) lock.expiresAt = Date.now() + ttlMs;
    return extended;
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.stopHeartbeat(this.lockHeartbeats, lock.token);
    await this.options.store.compareAndDelete(this.key("lock", lock.threadId), lock.token);
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.options.store.delete(this.key("lock", threadId));
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    const ttlMs = Math.max(1, entry.expiresAt - Date.now());
    const result = await this.options.store.enqueue(
      this.key("queue", threadId),
      JSON.stringify(entry),
      maxSize,
      ttlMs,
    );
    this.observe(() => this.options.onQueueDepth?.(threadId, result.depth));
    if (result.accepted) return result.depth;

    const messageId = entry.message.id;
    this.observe(() => this.options.onQueueOverload?.(threadId));
    await this.delete(`dedupe:slack:${messageId}`);
    throw new SlackIngressRetryableError(
      `Slack ingress queue is full; delivery ${messageId} was not accepted`,
      "SLACK_INGRESS_OVERLOADED",
      messageId,
      this.retryAfterMs,
    );
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const value = await this.options.store.dequeue(this.key("queue", threadId));
    const depth = await this.options.store.queueDepth(this.key("queue", threadId));
    this.observe(() => this.options.onQueueDepth?.(threadId, depth));
    return value === null ? null : JSON.parse(value) as QueueEntry;
  }

  async queueDepth(threadId: string): Promise<number> {
    const depth = await this.options.store.queueDepth(this.key("queue", threadId));
    this.observe(() => this.options.onQueueDepth?.(threadId, depth));
    return depth;
  }

  async claimDelivery(deliveryId: string, messageId: string): Promise<SlackDeliveryClaimResult> {
    const token = crypto.randomUUID();
    const result = await this.options.store.claimDelivery(
      this.deliveryKey(deliveryId, "complete"),
      this.deliveryKey(deliveryId, "lease"),
      token,
      this.visibilityTimeoutMs,
    );
    if (result === "duplicate") return { status: "duplicate", retryable: false };
    if (result === "in-flight") {
      return { status: "in-flight", retryable: true, retryAfterMs: this.retryAfterMs };
    }
    const claim = { deliveryId, messageId, token };
    this.startDeliveryHeartbeat(claim);
    return { status: "claimed", claim, retryable: false };
  }

  async ackDelivery(claim: SlackDeliveryClaim): Promise<boolean> {
    this.stopHeartbeat(this.deliveryHeartbeats, claim.token);
    const completed = await this.options.store.completeDelivery(
      this.deliveryKey(claim.deliveryId, "complete"),
      this.deliveryKey(claim.deliveryId, "lease"),
      claim.token,
      this.completionTtlMs,
    );
    if (completed) await this.set(`dedupe:slack:${claim.messageId}`, true, this.completionTtlMs);
    return completed;
  }

  async retryDelivery(claim: SlackDeliveryClaim): Promise<boolean> {
    this.stopHeartbeat(this.deliveryHeartbeats, claim.token);
    const released = await this.options.store.retryDelivery(
      this.deliveryKey(claim.deliveryId, "lease"),
      claim.token,
    );
    if (released) await this.delete(`dedupe:slack:${claim.messageId}`);
    return released;
  }

  private key(kind: string, key: string): string { return `${this.prefix}:${kind}:${key}`; }

  private deliveryKey(deliveryId: string, kind: "complete" | "lease"): string {
    const encoded = Buffer.from(deliveryId, "utf8").toString("base64url");
    return `${this.prefix}:delivery:{${encoded}}:${kind}`;
  }

  private startLockHeartbeat(lock: Lock, ttlMs: number): void {
    if (!this.heartbeat) return;
    const timer = setInterval(() => {
      void this.extendLock(lock, ttlMs).then(extended => {
        if (!extended) this.stopHeartbeat(this.lockHeartbeats, lock.token);
      }).catch(() => this.stopHeartbeat(this.lockHeartbeats, lock.token));
    }, Math.max(1_000, Math.floor(ttlMs / 3)));
    timer.unref?.();
    this.lockHeartbeats.set(lock.token, timer);
  }

  private startDeliveryHeartbeat(claim: SlackDeliveryClaim): void {
    if (!this.heartbeat) return;
    const timer = setInterval(() => {
      void this.options.store.compareAndExpire(
        this.deliveryKey(claim.deliveryId, "lease"),
        claim.token,
        this.visibilityTimeoutMs,
      ).then(extended => {
        if (!extended) this.stopHeartbeat(this.deliveryHeartbeats, claim.token);
      }).catch(() => this.stopHeartbeat(this.deliveryHeartbeats, claim.token));
    }, Math.max(1_000, Math.floor(this.visibilityTimeoutMs / 3)));
    timer.unref?.();
    this.deliveryHeartbeats.set(claim.token, timer);
  }

  private stopHeartbeat(
    heartbeats: Map<string, ReturnType<typeof setInterval>>,
    token: string,
  ): void {
    const timer = heartbeats.get(token);
    if (timer) clearInterval(timer);
    heartbeats.delete(token);
  }

  private observe(callback: () => void): void {
    try { callback(); } catch { /* Metrics must never change ingress admission semantics. */ }
  }
}

export function createRedisSlackIngressState(options: SlackIngressRedisOptions): SlackIngressStateAdapter {
  const client = new Redis({
    host: options.host,
    port: options.port,
    ...(options.username ? { username: options.username } : {}),
    ...(options.password ? { password: options.password } : {}),
    ...(options.tls ? { tls: options.tlsServername ? { servername: options.tlsServername } : {} } : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  return new SlackIngressStateAdapter({
    keyPrefix: `${options.keyPrefix}:slack-ingress`,
    store: new RedisSlackIngressStore(client),
    ...(options.onQueueDepth ? { onQueueDepth: options.onQueueDepth } : {}),
    ...(options.onQueueOverload ? { onQueueOverload: options.onQueueOverload } : {}),
  });
}

export function slackDeliveryId(input: {
  installationId?: string;
  workspaceId: string;
  messageId: string;
}): string {
  return `slack:${input.installationId ?? input.workspaceId}:${input.messageId}`;
}
