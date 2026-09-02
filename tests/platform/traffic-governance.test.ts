import { describe, expect, it, vi } from "vitest";
import {
  InMemoryTrafficGovernanceStore,
  RedisTrafficGovernanceStore,
  createRequestBodyLimitMiddleware,
  createTrafficGovernanceMiddleware,
  hashTrafficKey,
  type TrafficGovernanceLimits,
  type TrafficGovernanceOptions,
  type TrafficGovernanceStore,
} from "../../src/platform/http/traffic-governance.ts";

const DEFAULT_LIMITS: TrafficGovernanceLimits = {
  requestBodyMaxBytes: 1_024,
  standard: { tenantLimit: 100, subjectLimit: 100, windowMs: 60_000 },
  expensive: {
    tenantLimit: 20,
    subjectLimit: 10,
    windowMs: 60_000,
    tenantConcurrency: 2,
    leaseTtlMs: 30_000,
  },
};

describe("traffic governance middleware", () => {
  it("isolates fixed-window counters by tenant and subject", async () => {
    const harness = createHarness({
      limits: {
        ...DEFAULT_LIMITS,
        standard: { tenantLimit: 2, subjectLimit: 1, windowMs: 60_000 },
      },
    });

    expect((await harness.invoke({ tenantId: "tenant-a", subjectId: "user-1" })).nextCalled).toBe(true);
    expect((await harness.invoke({ tenantId: "tenant-a", subjectId: "user-1" })).response?.status).toBe(429);
    expect((await harness.invoke({ tenantId: "tenant-a", subjectId: "user-2" })).nextCalled).toBe(true);
    expect((await harness.invoke({ tenantId: "tenant-b", subjectId: "user-1" })).nextCalled).toBe(true);

    const tenantLimited = await harness.invoke({ tenantId: "tenant-a", subjectId: "user-3" });
    expect(await tenantLimited.response?.json()).toMatchObject({
      error: "rate_limit_exceeded",
      policy: "standard",
      scope: "tenant",
      reason: "fixed_window",
    });
  });

  it("returns 429 with Retry-After and admits requests again in the next fixed window", async () => {
    let nowMs = 0;
    const harness = createHarness({
      clock: () => nowMs,
      limits: {
        ...DEFAULT_LIMITS,
        standard: { tenantLimit: 1, subjectLimit: 1, windowMs: 60_000 },
      },
    });

    expect((await harness.invoke({ tenantId: "tenant-a", subjectId: "user-1" })).nextCalled).toBe(true);
    const limited = await harness.invoke({ tenantId: "tenant-a", subjectId: "user-1" });
    expect(limited.response?.status).toBe(429);
    expect(limited.response?.headers.get("retry-after")).toBe("60");
    expect(limited.response?.headers.get("cache-control")).toBe("no-store");

    nowMs = 60_000;
    expect((await harness.invoke({ tenantId: "tenant-a", subjectId: "user-1" })).nextCalled).toBe(true);
  });

  it("applies an additional quota only to explicitly expensive paths", async () => {
    const harness = createHarness({
      limits: {
        ...DEFAULT_LIMITS,
        expensive: { ...DEFAULT_LIMITS.expensive, tenantLimit: 1, subjectLimit: 1 },
      },
    });

    expect((await harness.invoke({ path: "/v1/expensive", tenantId: "tenant-a", subjectId: "user-1" })).nextCalled).toBe(true);
    const expensiveLimited = await harness.invoke({ path: "/v1/expensive", tenantId: "tenant-a", subjectId: "user-1" });
    expect(await expensiveLimited.response?.json()).toMatchObject({ policy: "expensive", reason: "fixed_window" });
    expect((await harness.invoke({ path: "/v1/cheap", tenantId: "tenant-a", subjectId: "user-1" })).nextCalled).toBe(true);
  });

  it("holds a tenant concurrency lease for expensive work and releases it in finally", async () => {
    let entered!: () => void;
    let unblock!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const blocker = new Promise<void>(resolve => { unblock = resolve; });
    const harness = createHarness({
      limits: {
        ...DEFAULT_LIMITS,
        expensive: { ...DEFAULT_LIMITS.expensive, tenantConcurrency: 1 },
      },
    });

    const first = harness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-a",
      subjectId: "user-1",
      next: async () => {
        entered();
        await blocker;
      },
    });
    await enteredPromise;

    const concurrent = await harness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-a",
      subjectId: "user-2",
    });
    expect(await concurrent.response?.json()).toMatchObject({
      error: "rate_limit_exceeded",
      policy: "expensive",
      scope: "tenant",
      reason: "concurrency",
    });

    unblock();
    await first;
    await expect(harness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-a",
      subjectId: "user-3",
      next: async () => { throw new Error("downstream failed"); },
    })).rejects.toThrow("downstream failed");
    expect((await harness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-a",
      subjectId: "user-4",
    })).nextCalled).toBe(true);
  });

  it("holds an expensive lease until a streaming response finishes", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    });
    const harness = createHarness({
      limits: {
        ...DEFAULT_LIMITS,
        expensive: { ...DEFAULT_LIMITS.expensive, tenantConcurrency: 1 },
      },
    });
    const first = await harness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-a",
      subjectId: "user-1",
      downstreamResponse: new Response(stream),
    });
    expect(first.response).toBeDefined();
    expect((await harness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-a",
      subjectId: "user-2",
    })).response?.status).toBe(429);

    streamController.enqueue(new TextEncoder().encode("complete"));
    streamController.close();
    await expect(first.response!.text()).resolves.toBe("complete");
    expect((await harness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-a",
      subjectId: "user-3",
    })).nextCalled).toBe(true);
  });

  it("does not share expensive concurrency between tenants", async () => {
    let unblock!: () => void;
    let entered!: () => void;
    const blocker = new Promise<void>(resolve => { unblock = resolve; });
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const harness = createHarness({
      limits: {
        ...DEFAULT_LIMITS,
        expensive: { ...DEFAULT_LIMITS.expensive, tenantConcurrency: 1 },
      },
    });
    const first = harness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-a",
      subjectId: "user-1",
      next: async () => { entered(); await blocker; },
    });
    await enteredPromise;

    expect((await harness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-b",
      subjectId: "user-1",
    })).nextCalled).toBe(true);
    unblock();
    await first;
  });

  it("enforces declared body size before public and identity exemptions", async () => {
    const harness = createHarness({ isPublicRequest: request => request.path === "/healthz" });
    const tooLarge = await harness.invoke({ path: "/healthz", contentLength: "1025" });
    expect(tooLarge.response?.status).toBe(413);
    expect(await tooLarge.response?.json()).toMatchObject({ error: "request_body_too_large", maxBytes: 1_024 });

    const malformed = await harness.invoke({ path: "/healthz", contentLength: "1e3" });
    expect(malformed.response?.status).toBe(400);
    expect(await malformed.response?.json()).toMatchObject({ error: "invalid_content_length" });
  });

  it("streams and rejects an oversized undeclared request body", async () => {
    const harness = createHarness();
    const oversized = await harness.invoke({
      tenantId: "tenant-a",
      subjectId: "user-1",
      body: "x".repeat(1_025),
    });
    expect(oversized.nextCalled).toBe(false);
    expect(oversized.response?.status).toBe(413);
    expect(await oversized.response?.json()).toMatchObject({ error: "request_body_too_large", maxBytes: 1_024 });
  });

  it("supports a pre-authorization body gate and marks the request as checked", async () => {
    const middleware = createRequestBodyLimitMiddleware(1_024);
    const values = new Map<string, unknown>();
    const next = vi.fn(async () => undefined);
    const raw = new Request("https://qasey.example.com/v1/tasks", { method: "POST", body: "small" });
    await middleware({
      req: {
        raw,
        path: "/v1/tasks",
        method: "POST",
        header: () => undefined,
      },
      get: (key: string) => key === "requestContext"
        ? { set: (name: string, value: unknown) => values.set(name, value) }
        : undefined,
      header: vi.fn(),
      json: vi.fn(),
    } as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(values.get("platform-body-limit-checked")).toBe(true);
  });

  it("allows public requests and preflight, but fails closed when a protected subject is missing", async () => {
    const harness = createHarness({ isPublicRequest: request => request.path === "/healthz" });
    expect((await harness.invoke({ path: "/healthz", method: "GET" })).nextCalled).toBe(true);
    expect((await harness.invoke({ path: "/v1/tasks", method: "OPTIONS" })).nextCalled).toBe(true);

    const missing = await harness.invoke({ path: "/v1/tasks", method: "GET", tenantId: "tenant-a" });
    expect(missing.response?.status).toBe(401);
    expect(await missing.response?.json()).toMatchObject({ error: "traffic_identity_required" });
  });

  it("fails closed with 503 when quota or concurrency storage is unavailable", async () => {
    const quotaStore = failingStore("quota unavailable");
    const quotaHarness = createHarness({ store: quotaStore });
    const quotaFailure = await quotaHarness.invoke({ tenantId: "tenant-a", subjectId: "user-1" });
    expect(quotaFailure.response?.status).toBe(503);
    expect(await quotaFailure.response?.json()).toMatchObject({ error: "traffic_governance_unavailable" });

    const leaseStore = failingStore(undefined, "lease unavailable");
    const leaseHarness = createHarness({ store: leaseStore });
    const leaseFailure = await leaseHarness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-a",
      subjectId: "user-1",
    });
    expect(leaseFailure.response?.status).toBe(503);
    expect(leaseFailure.nextCalled).toBe(false);
  });

  it("reports lease release failures without making completed work retryable", async () => {
    const onStoreError = vi.fn();
    const base = new InMemoryTrafficGovernanceStore();
    const store: TrafficGovernanceStore = {
      consumeFixedWindow: (entries, nowMs) => base.consumeFixedWindow(entries, nowMs),
      acquireConcurrencyLease: (key, limit, ttl, nowMs) => base.acquireConcurrencyLease(key, limit, ttl, nowMs),
      releaseConcurrencyLease: async () => { throw new Error("release unavailable"); },
    };
    const harness = createHarness({ store, onStoreError });

    expect((await harness.invoke({
      path: "/v1/expensive",
      tenantId: "tenant-a",
      subjectId: "user-1",
    })).nextCalled).toBe(true);
    expect(onStoreError).toHaveBeenCalledWith(expect.any(Error), "release");
  });

  it("rejects unsafe numeric configuration at construction", () => {
    expect(() => createHarness({
      limits: { ...DEFAULT_LIMITS, requestBodyMaxBytes: 0 },
    })).toThrow(/requestBodyMaxBytes/iu);
    expect(() => createHarness({
      limits: {
        ...DEFAULT_LIMITS,
        expensive: { ...DEFAULT_LIMITS.expensive, tenantConcurrency: Number.NaN },
      },
    })).toThrow(/tenantConcurrency/iu);
  });
});

describe("Redis traffic governance store", () => {
  it("uses one atomic script for every fixed-window layer and never exposes identity text in keys", async () => {
    const evalMock = vi.fn(async (
      _script: string,
      _numberOfKeys: number,
      ..._args: Array<string | number>
    ) => [1, 0, 0]);
    const store = new RedisTrafficGovernanceStore({ eval: evalMock });
    const harness = createHarness({ store });

    expect((await harness.invoke({
      tenantId: "tenant-secret-value",
      subjectId: "subject-secret-value",
    })).nextCalled).toBe(true);
    expect(evalMock).toHaveBeenCalledOnce();
    const [, numberOfKeys, ...args] = evalMock.mock.calls[0]!;
    expect(numberOfKeys).toBe(2);
    const serializedKeys = args.slice(0, numberOfKeys).join("|");
    expect(serializedKeys).not.toContain("tenant-secret-value");
    expect(serializedKeys).not.toContain("subject-secret-value");
    expect(serializedKeys).toMatch(/\{[a-f0-9]{64}\}/u);
  });

  it("uses atomic sorted-set scripts for bounded concurrency", async () => {
    const evalMock = vi.fn(async (script: string) => script.includes("ZREMRANGEBYSCORE")
      ? [1, 1, 30_000]
      : script.includes("ZREM")
        ? 1
        : [1, 0, 0]);
    const store = new RedisTrafficGovernanceStore({ eval: evalMock });
    const lease = await store.acquireConcurrencyLease("hashed-key", 1, 30_000, 0);
    expect(lease).toMatchObject({ acquired: true, retryAfterMs: 0 });
    await store.releaseConcurrencyLease("hashed-key", lease.token!);
    expect(evalMock).toHaveBeenCalledTimes(2);
  });
});

describe("traffic key hashing", () => {
  it("is deterministic, delimiter-safe, and does not contain source identifiers", () => {
    expect(hashTrafficKey("ab", "c")).not.toBe(hashTrafficKey("a", "bc"));
    expect(hashTrafficKey("tenant-a", "user-1")).toBe(hashTrafficKey("tenant-a", "user-1"));
    expect(hashTrafficKey("tenant-a", "user-1")).not.toContain("tenant-a");
    expect(hashTrafficKey("tenant-a", "user-1")).toMatch(/^[a-f0-9]{64}$/u);
  });
});

function createHarness(overrides: Partial<TrafficGovernanceOptions> = {}) {
  const middleware = createTrafficGovernanceMiddleware({
    store: new InMemoryTrafficGovernanceStore(),
    limits: DEFAULT_LIMITS,
    isExpensiveRequest: request => request.path === "/v1/expensive",
    clock: () => 0,
    ...overrides,
  });

  return {
    invoke: async (options: {
      path?: string;
      method?: string;
      tenantId?: string;
      subjectId?: string;
      contentLength?: string;
      body?: string;
      downstreamResponse?: Response;
      next?: () => Promise<void>;
    }) => {
      const method = options.method ?? "POST";
      const path = options.path ?? "/v1/tasks";
      const requestHeaders = new Headers();
      if (options.contentLength !== undefined) requestHeaders.set("content-length", options.contentLength);
      const responseHeaders = new Headers();
      const values = new Map<string, unknown>([["requestId", "request-1"]]);
      if (options.tenantId !== undefined) values.set("tenantId", options.tenantId);
      if (options.subjectId !== undefined) values.set("userId", options.subjectId);
      let nextCalled = false;
      const next = options.next ?? (async () => undefined);
      const raw = new Request(`https://qasey.example.com${path}`, {
        method,
        ...(options.body !== undefined ? { body: options.body } : {}),
      });
      const context = {
        req: {
          raw,
          path,
          method,
          header: (name: string) => requestHeaders.get(name) ?? undefined,
        },
        get: (key: string) => key === "requestContext" ? { get: (name: string) => values.get(name) } : undefined,
        header: (name: string, value: string) => responseHeaders.set(name, value),
        json: (body: unknown, status: number) => Response.json(body, { status, headers: responseHeaders }),
        res: undefined as Response | undefined,
      };
      const response = await middleware(context as never, async () => {
        nextCalled = true;
        await next();
        if (options.downstreamResponse) context.res = options.downstreamResponse;
      }) as Response | undefined;
      return { response: response ?? context.res, nextCalled };
    },
  };
}

function failingStore(quotaError?: string, leaseError?: string): TrafficGovernanceStore {
  return {
    consumeFixedWindow: async () => {
      if (quotaError) throw new Error(quotaError);
      return { allowed: true };
    },
    acquireConcurrencyLease: async () => {
      if (leaseError) throw new Error(leaseError);
      return { acquired: true, token: "lease-token", retryAfterMs: 0 };
    },
    releaseConcurrencyLease: async () => undefined,
  };
}
