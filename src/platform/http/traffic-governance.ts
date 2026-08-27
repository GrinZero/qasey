import { createHash, randomUUID } from "node:crypto";
import type { Middleware } from "@mastra/core/server";

type MiddlewareFunction = Extract<Middleware, (...args: never[]) => unknown>;

const FIXED_WINDOW_SCRIPT = `
for index = 1, #KEYS do
  local limit = tonumber(ARGV[(index - 1) * 2 + 1])
  local count = tonumber(redis.call("GET", KEYS[index]) or "0")
  if count >= limit then
    return {0, index, count}
  end
end
for index = 1, #KEYS do
  local expiresInMs = tonumber(ARGV[(index - 1) * 2 + 2])
  local count = redis.call("INCR", KEYS[index])
  if count == 1 or redis.call("PTTL", KEYS[index]) < 0 then
    redis.call("PEXPIRE", KEYS[index], expiresInMs)
  end
end
return {1, 0, 0}
`;

const ACQUIRE_LEASE_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
local count = redis.call("ZCARD", KEYS[1])
local limit = tonumber(ARGV[2])
if count >= limit then
  local oldest = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
  return {0, count, oldest[2] or ARGV[1]}
end
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[4])
redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[5]))
return {1, count + 1, ARGV[3]}
`;

const RELEASE_LEASE_SCRIPT = `
return redis.call("ZREM", KEYS[1], ARGV[1])
`;

export interface FixedWindowPolicy {
  tenantLimit: number;
  subjectLimit: number;
  windowMs: number;
}

export interface ExpensiveTrafficPolicy extends FixedWindowPolicy {
  tenantConcurrency: number;
  leaseTtlMs: number;
}

export interface TrafficGovernanceLimits {
  requestBodyMaxBytes: number;
  standard: FixedWindowPolicy;
  expensive: ExpensiveTrafficPolicy;
}

export interface TrafficIdentity {
  tenantId: string;
  subjectId: string;
}

export interface TrafficRequest {
  raw: Request;
  path: string;
  method: string;
  header(name: string): string | undefined;
}

export interface FixedWindowEntry {
  key: string;
  limit: number;
  expiresAtMs: number;
}

export interface FixedWindowDecision {
  allowed: boolean;
  deniedIndex?: number;
}

export interface ConcurrencyLease {
  acquired: boolean;
  token?: string;
  retryAfterMs: number;
}

/** Shared storage contract used by both the Redis and standalone runtimes. */
export interface TrafficGovernanceStore {
  consumeFixedWindow(entries: readonly FixedWindowEntry[], nowMs: number): Promise<FixedWindowDecision>;
  acquireConcurrencyLease(
    key: string,
    limit: number,
    leaseTtlMs: number,
    nowMs: number,
  ): Promise<ConcurrencyLease>;
  releaseConcurrencyLease(key: string, token: string): Promise<void>;
}

/** The subset of ioredis used by traffic governance, kept structural for easy injection and testing. */
export interface RedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface TrafficGovernanceOptions {
  store: TrafficGovernanceStore;
  limits: TrafficGovernanceLimits;
  keyPrefix?: string;
  exemptMethods?: readonly string[];
  clock?: () => number;
  resolveIdentity?: (context: unknown, request: TrafficRequest) => TrafficIdentity | undefined | Promise<TrafficIdentity | undefined>;
  isPublicRequest?: (request: TrafficRequest) => boolean;
  isExpensiveRequest: (request: TrafficRequest, context: unknown) => boolean;
  onRejected?: (input: {
    policy: "standard" | "expensive";
    scope: "tenant" | "subject";
    reason: "fixed_window" | "concurrency";
  }) => void;
  onStoreError?: (error: unknown, operation: "admit" | "release") => void;
}

interface QuotaDescriptor {
  policy: "standard" | "expensive";
  scope: "tenant" | "subject";
  entry: FixedWindowEntry;
}

interface MemoryLease {
  token: string;
  expiresAtMs: number;
}

/** Standalone implementation. Every mutation is synchronous between awaits, so admission remains atomic per process. */
export class InMemoryTrafficGovernanceStore implements TrafficGovernanceStore {
  private readonly counters = new Map<string, { count: number; expiresAtMs: number }>();
  private readonly leases = new Map<string, Map<string, MemoryLease>>();
  private nextCounterExpiryMs = Number.POSITIVE_INFINITY;
  private nextLeaseExpiryMs = Number.POSITIVE_INFINITY;

  async consumeFixedWindow(entries: readonly FixedWindowEntry[], nowMs: number): Promise<FixedWindowDecision> {
    this.pruneCounters(nowMs);
    for (const [index, entry] of entries.entries()) {
      const current = this.counters.get(entry.key);
      if (current && current.expiresAtMs > nowMs && current.count >= entry.limit) {
        return { allowed: false, deniedIndex: index };
      }
    }

    for (const entry of entries) {
      const current = this.counters.get(entry.key);
      if (!current || current.expiresAtMs <= nowMs) {
        this.counters.set(entry.key, { count: 1, expiresAtMs: entry.expiresAtMs });
        this.nextCounterExpiryMs = Math.min(this.nextCounterExpiryMs, entry.expiresAtMs);
      } else {
        current.count += 1;
      }
    }
    return { allowed: true };
  }

  async acquireConcurrencyLease(
    key: string,
    limit: number,
    leaseTtlMs: number,
    nowMs: number,
  ): Promise<ConcurrencyLease> {
    this.pruneLeases(nowMs);
    const active = this.leases.get(key) ?? new Map<string, MemoryLease>();
    if (active.size >= limit) {
      let oldestExpiry = Number.POSITIVE_INFINITY;
      for (const lease of active.values()) oldestExpiry = Math.min(oldestExpiry, lease.expiresAtMs);
      if (active.size > 0) this.leases.set(key, active);
      return { acquired: false, retryAfterMs: Math.max(1, oldestExpiry - nowMs) };
    }

    const token = randomUUID();
    active.set(token, { token, expiresAtMs: nowMs + leaseTtlMs });
    this.nextLeaseExpiryMs = Math.min(this.nextLeaseExpiryMs, nowMs + leaseTtlMs);
    this.leases.set(key, active);
    return { acquired: true, token, retryAfterMs: 0 };
  }

  async releaseConcurrencyLease(key: string, token: string): Promise<void> {
    const active = this.leases.get(key);
    if (!active) return;
    active.delete(token);
    if (active.size === 0) this.leases.delete(key);
  }

  private pruneCounters(nowMs: number): void {
    if (nowMs < this.nextCounterExpiryMs) return;
    this.nextCounterExpiryMs = Number.POSITIVE_INFINITY;
    for (const [key, counter] of this.counters) {
      if (counter.expiresAtMs <= nowMs) this.counters.delete(key);
      else this.nextCounterExpiryMs = Math.min(this.nextCounterExpiryMs, counter.expiresAtMs);
    }
  }

  private pruneLeases(nowMs: number): void {
    if (nowMs < this.nextLeaseExpiryMs) return;
    this.nextLeaseExpiryMs = Number.POSITIVE_INFINITY;
    for (const [key, active] of this.leases) {
      for (const [token, lease] of active) {
        if (lease.expiresAtMs <= nowMs) active.delete(token);
        else this.nextLeaseExpiryMs = Math.min(this.nextLeaseExpiryMs, lease.expiresAtMs);
      }
      if (active.size === 0) this.leases.delete(key);
    }
  }
}

/** Redis implementation. Lua makes each multi-layer fixed-window decision all-or-nothing. */
export class RedisTrafficGovernanceStore implements TrafficGovernanceStore {
  constructor(private readonly client: RedisEvalClient) {}

  async consumeFixedWindow(entries: readonly FixedWindowEntry[], nowMs: number): Promise<FixedWindowDecision> {
    if (entries.length === 0) return { allowed: true };
    const args = entries.flatMap(entry => [entry.limit, Math.max(1, entry.expiresAtMs - nowMs)]);
    const raw = await this.client.eval(
      FIXED_WINDOW_SCRIPT,
      entries.length,
      ...entries.map(entry => entry.key),
      ...args,
    );
    const result = numericArray(raw, "fixed-window quota");
    if (result[0] === 1) return { allowed: true };
    const deniedIndex = (result[1] ?? 0) - 1;
    if (deniedIndex < 0 || deniedIndex >= entries.length) {
      throw new Error("Redis returned an invalid fixed-window quota index");
    }
    return { allowed: false, deniedIndex };
  }

  async acquireConcurrencyLease(
    key: string,
    limit: number,
    leaseTtlMs: number,
    nowMs: number,
  ): Promise<ConcurrencyLease> {
    const token = randomUUID();
    const expiresAtMs = nowMs + leaseTtlMs;
    const raw = await this.client.eval(
      ACQUIRE_LEASE_SCRIPT,
      1,
      key,
      nowMs,
      limit,
      expiresAtMs,
      token,
      leaseTtlMs,
    );
    const result = numericArray(raw, "concurrency lease");
    if (result[0] === 1) return { acquired: true, token, retryAfterMs: 0 };
    return { acquired: false, retryAfterMs: Math.max(1, (result[2] ?? nowMs + 1) - nowMs) };
  }

  async releaseConcurrencyLease(key: string, token: string): Promise<void> {
    await this.client.eval(RELEASE_LEASE_SCRIPT, 1, key, token);
  }
}

/** Hashes every untrusted identity component before it becomes part of a storage key. */
export function hashTrafficKey(...components: readonly string[]): string {
  const digest = createHash("sha256");
  for (const component of components) {
    digest.update(String(Buffer.byteLength(component, "utf8")));
    digest.update(":");
    digest.update(component);
    digest.update("\0");
  }
  return digest.digest("hex");
}

/** Run this before authorization so an unauthenticated chunked body cannot be
 * buffered by route classification. Traffic governance repeats the check as a
 * safe standalone default when consumers install only the combined middleware.
 */
export function createRequestBodyLimitMiddleware(maxBytes: number): MiddlewareFunction {
  positiveInteger(maxBytes, "requestBodyMaxBytes");
  return async (context, next) => {
    const request = context.req as TrafficRequest;
    const declaredLength = parseContentLength(request.header("content-length"));
    if (declaredLength === "invalid") {
      context.header("cache-control", "no-store");
      return context.json({ error: "invalid_content_length" }, 400);
    }
    if (declaredLength !== undefined && declaredLength > maxBytes) {
      context.header("cache-control", "no-store");
      return context.json({ error: "request_body_too_large", maxBytes }, 413);
    }
    if (declaredLength === undefined && methodMayHaveBody(request.method)) {
      try {
        if (!await bodyWithinLimit(request.raw, maxBytes)) {
          context.header("cache-control", "no-store");
          return context.json({ error: "request_body_too_large", maxBytes }, 413);
        }
      } catch {
        context.header("cache-control", "no-store");
        return context.json({ error: "invalid_request_body" }, 400);
      }
    }
    const requestContext = context.get("requestContext") as { set?(key: string, value: unknown): void } | undefined;
    requestContext?.set?.("platform-body-limit-checked", true);
    return next();
  };
}

export function createTrafficGovernanceMiddleware(options: TrafficGovernanceOptions): MiddlewareFunction {
  validateLimits(options.limits);
  const keyPrefix = options.keyPrefix ?? "qasey:traffic";
  const exemptMethods = new Set((options.exemptMethods ?? ["OPTIONS"]).map(method => method.toUpperCase()));
  const clock = options.clock ?? Date.now;
  const resolveIdentity = options.resolveIdentity ?? resolveRequestContextIdentity;

  return async (context, next) => {
    const request = context.req as TrafficRequest;
    const requestContext = context.get("requestContext") as { get(key: string): unknown } | undefined;
    const requestId = requestContext?.get("requestId");
    const responseMetadata = typeof requestId === "string" ? { requestId } : {};
    if (requestContext?.get("platform-body-limit-checked") !== true) {
      const declaredLength = parseContentLength(request.header("content-length"));
      if (declaredLength === "invalid") {
        return context.json({ error: "invalid_content_length", ...responseMetadata }, 400);
      }
      if (declaredLength !== undefined && declaredLength > options.limits.requestBodyMaxBytes) {
        return context.json({
          error: "request_body_too_large",
          maxBytes: options.limits.requestBodyMaxBytes,
          ...responseMetadata,
        }, 413);
      }
      if (declaredLength === undefined && methodMayHaveBody(request.method)) {
        let withinLimit: boolean;
        try {
          withinLimit = await bodyWithinLimit(request.raw, options.limits.requestBodyMaxBytes);
        } catch {
          return context.json({ error: "invalid_request_body", ...responseMetadata }, 400);
        }
        if (!withinLimit) {
          return context.json({
            error: "request_body_too_large",
            maxBytes: options.limits.requestBodyMaxBytes,
            ...responseMetadata,
          }, 413);
        }
      }
    }

    if (exemptMethods.has(request.method.toUpperCase()) || options.isPublicRequest?.(request)) return next();

    const identity = await resolveIdentity(context, request);
    if (!identity || !nonEmpty(identity.tenantId) || !nonEmpty(identity.subjectId)) {
      return context.json({ error: "traffic_identity_required", ...responseMetadata }, 401);
    }

    const nowMs = clock();
    const expensive = options.isExpensiveRequest(request, context);
    const tenantHash = hashTrafficKey(identity.tenantId);
    const hashSlot = `{${tenantHash}}`;
    const concurrencyKey = `${keyPrefix}:${hashSlot}:concurrency:expensive`;
    let leaseToken: string | undefined;

    try {
      if (expensive) {
        let lease: ConcurrencyLease;
        try {
          lease = await options.store.acquireConcurrencyLease(
            concurrencyKey,
            options.limits.expensive.tenantConcurrency,
            options.limits.expensive.leaseTtlMs,
            nowMs,
          );
        } catch (error) {
          reportStoreError(options, error, "admit");
          return unavailable(context, responseMetadata);
        }
        if (!lease.acquired || !lease.token) {
          reportRejected(options, { policy: "expensive", scope: "tenant", reason: "concurrency" });
          return limited(context, "expensive", "tenant", lease.retryAfterMs, responseMetadata, "concurrency");
        }
        leaseToken = lease.token;
      }

      const quotas = quotaDescriptors(keyPrefix, hashSlot, identity, options.limits, expensive, nowMs);
      let decision: FixedWindowDecision;
      try {
        decision = await options.store.consumeFixedWindow(quotas.map(quota => quota.entry), nowMs);
      } catch (error) {
        reportStoreError(options, error, "admit");
        return unavailable(context, responseMetadata);
      }
      if (!decision.allowed) {
        const denied = decision.deniedIndex === undefined ? undefined : quotas[decision.deniedIndex];
        if (!denied) {
          reportStoreError(options, new Error("Quota store returned an invalid denial"), "admit");
          return unavailable(context, responseMetadata);
        }
        reportRejected(options, { policy: denied.policy, scope: denied.scope, reason: "fixed_window" });
        return limited(
          context,
          denied.policy,
          denied.scope,
          Math.max(1, denied.entry.expiresAtMs - nowMs),
          responseMetadata,
          "fixed_window",
        );
      }

      const downstream = await next();
      const response = context.res as Response | undefined;
      if (leaseToken && response instanceof Response && response.body) {
        const token = leaseToken;
        leaseToken = undefined;
        context.res = responseWithRelease(response, async () => {
          try {
            await options.store.releaseConcurrencyLease(concurrencyKey, token);
          } catch (error) {
            reportStoreError(options, error, "release");
          }
        });
      }
      return downstream;
    } finally {
      if (leaseToken) {
        try {
          await options.store.releaseConcurrencyLease(concurrencyKey, leaseToken);
        } catch (error) {
          // A bounded lease self-heals. Do not turn a completed expensive
          // operation into a retryable 503, which could duplicate effects.
          reportStoreError(options, error, "release");
        }
      }
    }
  };
}

function quotaDescriptors(
  keyPrefix: string,
  hashSlot: string,
  identity: TrafficIdentity,
  limits: TrafficGovernanceLimits,
  expensive: boolean,
  nowMs: number,
): QuotaDescriptor[] {
  const descriptors = policyDescriptors(keyPrefix, hashSlot, identity, "standard", limits.standard, nowMs);
  if (expensive) {
    descriptors.push(...policyDescriptors(keyPrefix, hashSlot, identity, "expensive", limits.expensive, nowMs));
  }
  return descriptors;
}

function policyDescriptors(
  keyPrefix: string,
  hashSlot: string,
  identity: TrafficIdentity,
  policy: "standard" | "expensive",
  limits: FixedWindowPolicy,
  nowMs: number,
): QuotaDescriptor[] {
  const windowStart = Math.floor(nowMs / limits.windowMs) * limits.windowMs;
  const expiresAtMs = windowStart + limits.windowMs;
  return [
    {
      policy,
      scope: "tenant",
      entry: {
        key: `${keyPrefix}:${hashSlot}:quota:${policy}:tenant:${hashTrafficKey(identity.tenantId)}:${windowStart}`,
        limit: limits.tenantLimit,
        expiresAtMs,
      },
    },
    {
      policy,
      scope: "subject",
      entry: {
        key: `${keyPrefix}:${hashSlot}:quota:${policy}:subject:${hashTrafficKey(identity.tenantId, identity.subjectId)}:${windowStart}`,
        limit: limits.subjectLimit,
        expiresAtMs,
      },
    },
  ];
}

function resolveRequestContextIdentity(context: unknown): TrafficIdentity | undefined {
  if (!isRecord(context) || typeof context.get !== "function") return undefined;
  const requestContext = context.get("requestContext");
  if (!isRecord(requestContext) || typeof requestContext.get !== "function") return undefined;
  const tenantId = requestContext.get("tenantId");
  const subjectId = requestContext.get("userId");
  return typeof tenantId === "string" && typeof subjectId === "string" ? { tenantId, subjectId } : undefined;
}

function parseContentLength(raw: string | undefined): number | "invalid" | undefined {
  if (raw === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) return "invalid";
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

async function bodyWithinLimit(request: Request, maxBytes: number): Promise<boolean> {
  const body = request.clone().body;
  if (!body) return true;
  const reader = body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return true;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        // A cloned Request body is a tee. Awaiting cancellation can wait for
        // the untouched downstream branch, so signal cancellation without
        // turning an oversized request into a hung connection.
        void reader.cancel().catch(() => undefined);
        void request.body?.cancel().catch(() => undefined);
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function methodMayHaveBody(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function responseWithRelease(response: Response, release: () => Promise<void>): Response {
  const reader = response.body!.getReader();
  let released = false;
  const releaseOnce = async () => {
    if (released) return;
    released = true;
    await release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await releaseOnce();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await releaseOnce();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await releaseOnce();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function limited(
  context: { header(name: string, value: string): void; json(body: unknown, status: 429): Response },
  policy: "standard" | "expensive",
  scope: "tenant" | "subject",
  retryAfterMs: number,
  metadata: { requestId?: string },
  reason: "fixed_window" | "concurrency",
): Response {
  context.header("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  context.header("cache-control", "no-store");
  return context.json({ error: "rate_limit_exceeded", policy, scope, reason, ...metadata }, 429);
}

function unavailable(
  context: { header(name: string, value: string): void; json(body: unknown, status: 503): Response },
  metadata: { requestId?: string },
): Response {
  context.header("cache-control", "no-store");
  return context.json({ error: "traffic_governance_unavailable", ...metadata }, 503);
}

function numericArray(raw: unknown, operation: string): number[] {
  if (!Array.isArray(raw)) throw new Error(`Redis returned an invalid ${operation} response`);
  const values = raw.map(value => Number(value));
  if (values.some(value => !Number.isFinite(value))) {
    throw new Error(`Redis returned a non-numeric ${operation} response`);
  }
  return values;
}

function validateLimits(limits: TrafficGovernanceLimits): void {
  positiveInteger(limits.requestBodyMaxBytes, "requestBodyMaxBytes");
  validateWindow(limits.standard, "standard");
  validateWindow(limits.expensive, "expensive");
  positiveInteger(limits.expensive.tenantConcurrency, "expensive.tenantConcurrency");
  positiveInteger(limits.expensive.leaseTtlMs, "expensive.leaseTtlMs");
}

function validateWindow(policy: FixedWindowPolicy, label: string): void {
  positiveInteger(policy.tenantLimit, `${label}.tenantLimit`);
  positiveInteger(policy.subjectLimit, `${label}.subjectLimit`);
  positiveInteger(policy.windowMs, `${label}.windowMs`);
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function reportStoreError(
  options: TrafficGovernanceOptions,
  error: unknown,
  operation: "admit" | "release",
): void {
  try {
    options.onStoreError?.(error, operation);
  } catch {
    // Error reporting must never change admission behavior.
  }
}

function reportRejected(
  options: TrafficGovernanceOptions,
  input: { policy: "standard" | "expensive"; scope: "tenant" | "subject"; reason: "fixed_window" | "concurrency" },
): void {
  try {
    options.onRejected?.(input);
  } catch {
    // Metrics and logging must never change an admission decision.
  }
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
