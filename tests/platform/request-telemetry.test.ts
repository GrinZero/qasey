import { describe, expect, it, vi } from "vitest";
import { createRequestTelemetryMiddleware } from "../../src/platform/http/request-telemetry.ts";

describe("HTTP request telemetry middleware", () => {
  it("records bounded authorization route metadata and response status", async () => {
    const observe = vi.fn();
    const times = [100, 350];
    const middleware = createRequestTelemetryMiddleware({ observe, now: () => times.shift() ?? 350 });
    const values = new Map<string, unknown>([
      ["applicationId", "qasey"],
      ["platform-route-id", "task-create"],
    ]);
    const context = {
      req: { path: "/v1/qasey/tasks", method: "POST" },
      res: { status: 202 },
      get: (key: string) => key === "requestContext" ? { get: (name: string) => values.get(name) } : undefined,
    };

    await middleware(context as never, async () => undefined);

    expect(observe).toHaveBeenCalledWith({
      applicationId: "qasey",
      routeId: "task-create",
      method: "POST",
      status: 202,
      durationMs: 250,
    });
  });

  it("records failures as 500 and rethrows the application error", async () => {
    const observe = vi.fn();
    const middleware = createRequestTelemetryMiddleware({ observe, now: () => 10 });
    const context = {
      req: { path: "/unknown/user-specific-value", method: "GET" },
      get: () => ({ get: () => undefined }),
    };
    const failure = new Error("synthetic failure");
    await expect(middleware(context as never, async () => { throw failure; })).rejects.toBe(failure);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      applicationId: "platform",
      routeId: "unclassified",
      status: 500,
    }));
  });

  it("does not fail a request when the bounded metrics registry rejects a new series", async () => {
    const onObservationError = vi.fn();
    const middleware = createRequestTelemetryMiddleware({
      observe: () => { throw new Error("series limit"); },
      onObservationError,
    });
    const context = {
      req: { path: "/healthz", method: "GET" },
      res: { status: 200 },
      get: () => ({ get: () => undefined }),
    };
    await expect(middleware(context as never, async () => undefined)).resolves.toBeUndefined();
    expect(onObservationError).toHaveBeenCalledWith(expect.objectContaining({ message: "series limit" }));
  });
});
