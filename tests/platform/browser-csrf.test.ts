import { describe, expect, it, vi } from "vitest";
import { createBrowserCsrfMiddleware } from "../../src/platform/http/browser-csrf.ts";

const middleware = createBrowserCsrfMiddleware({ publicBaseUrl: "https://qasey.example.com/base" });

describe("browser CSRF middleware", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("allows safe browser method %s without Origin", async method => {
    const { context, next, json } = request({ method, user: { id: "user-1" } });
    await middleware(context as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("allows same-origin browser method %s", async method => {
    const { context, next } = request({ method, origin: "https://qasey.example.com", user: { id: "user-1" } });
    await middleware(context as never, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([undefined, "null", "https://attacker.example.com", "https://qasey.example.com.evil.example"])(
    "rejects browser mutation from origin %s",
    async origin => {
      const { context, next, json, header } = request({
        method: "POST",
        ...(origin !== undefined ? { origin } : {}),
        user: { id: "user-1" },
      });
      await middleware(context as never, next);
      expect(next).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith({ error: "csrf_rejected", requestId: "request-1" }, 403);
      expect(header).toHaveBeenCalledWith("cache-control", "no-store");
      expect(header).toHaveBeenCalledWith("vary", "Origin");
    },
  );

  it("protects an admin-ui principal even when no hydrated OIDC user is present", async () => {
    const { context, next, json } = request({
      method: "DELETE",
      principal: { audience: "admin-ui" },
    });
    await middleware(context as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ error: "csrf_rejected", requestId: "request-1" }, 403);
  });

  it("does not impose browser headers on API and service principals", async () => {
    for (const audience of ["api", "service", "channel"]) {
      const { context, next } = request({ method: "POST", principal: { audience } });
      await middleware(context as never, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });
});

function request(options: {
  method: string;
  origin?: string;
  user?: unknown;
  principal?: unknown;
}) {
  const values = new Map<string, unknown>([["requestId", "request-1"]]);
  if (options.user !== undefined) values.set("user", options.user);
  if (options.principal !== undefined) values.set("platform-principal", options.principal);
  const next = vi.fn(async () => undefined);
  const json = vi.fn();
  const header = vi.fn();
  return {
    next,
    json,
    header,
    context: {
      req: {
        method: options.method,
        header: (name: string) => name.toLowerCase() === "origin" ? options.origin : undefined,
      },
      get: (key: string) => key === "requestContext" ? { get: (name: string) => values.get(name) } : undefined,
      json,
      header,
    },
  };
}
