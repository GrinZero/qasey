import { describe, expect, it } from "vitest";
import { applyStudioNetworkPolicy, isStudioDocumentPath, STUDIO_CONNECT_SRC_POLICY } from "../../src/platform/http/studio-network-policy.ts";

describe("Studio browser network policy", () => {
  it.each(["/studio", "/studio/agents", "/studio/assets/main.js"])("keeps %s connections same-origin", async path => {
    const headers = new Headers();
    const context = {
      req: { path, method: "GET" },
      header: (name: string, value: string) => headers.set(name, value),
    };

    await applyStudioNetworkPolicy(context as never, async () => undefined);

    expect(headers.get("Content-Security-Policy")).toBe(STUDIO_CONNECT_SRC_POLICY);
  });

  it("does not attach a document policy to Studio API responses", async () => {
    expect(isStudioDocumentPath("/studio/api/agents", "GET")).toBe(false);
    const headers = new Headers();
    const context = {
      req: { path: "/studio/api/agents", method: "GET" },
      header: (name: string, value: string) => headers.set(name, value),
    };

    await applyStudioNetworkPolicy(context as never, async () => undefined);

    expect(headers.has("Content-Security-Policy")).toBe(false);
  });
});
