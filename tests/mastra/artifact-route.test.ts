import { describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";

vi.mock("../../src/mastra/applications/qasey/collaboration.ts", () => ({ acceptCollaborationMessage: vi.fn(), attachConversationRuns: vi.fn() }));
vi.mock("../../src/mastra/workflows/e2e-workflow.ts", () => ({ cancelE2ERun: vi.fn(), dispatchE2ERepair: vi.fn(), rerunE2E: vi.fn(), resumeE2EWithVerdict: vi.fn() }));
vi.mock("../../src/mastra/applications/qasey/service.ts", () => ({ executeQasey: vi.fn() }));
vi.mock("../../src/mastra/runtime.ts", () => ({
  config: { NODE_ENV: "test" },
  runRepository: { get: vi.fn() },
  artifactStore: { open: vi.fn(), size: vi.fn() },
}));

import { apiRoutes } from "../../src/mastra/applications/qasey/routes.ts";
import { artifactStore, runRepository } from "../../src/mastra/runtime.ts";

describe("artifact download route", () => {
  it.each([
    { name: "results/折叠侧边栏-trace.zip", kind: "trace", contentType: undefined, expectedType: "application/zip" },
    { name: "results/折叠侧边栏-video.webm", kind: "video", contentType: "video/webm", expectedType: "video/webm" },
  ])("serves Unicode $kind evidence through real Fetch headers", async artifact => {
    const entry = { ...artifact, id: "public-artifact" };
    vi.mocked(runRepository.get).mockResolvedValue({ artifacts: [entry] } as never);
    vi.mocked(artifactStore.size).mockResolvedValue(3);
    vi.mocked(artifactStore.open).mockResolvedValue({ body: new Uint8Array([1, 2, 3]), contentLength: 3 } as never);
    const headers = new Headers();
    const requestContext = new RequestContext();
    requestContext.set("applicationId", "qasey");
    requestContext.set("identity", { tenantId: "public-test" });
    const route = apiRoutes.find(route => route.path === "/v1/case-hub/runs/:runId/artifacts/:artifactId")!;
    if (!("handler" in route) || !route.handler) throw new Error("Artifact route handler is missing");
    const response = await route.handler({
      get: () => requestContext,
      req: { param: (name: string) => name === "runId" ? "public-run" : entry.id, header: () => undefined },
      header: (name: string, value: string) => headers.set(name, value),
      body: (body: BodyInit, status = 200) => new Response(body, { status, headers }),
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
    } as never, async () => undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(artifact.expectedType);
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(decodeURIComponent(response.headers.get("content-disposition")!.split("filename*=UTF-8''")[1]!)).toBe(artifact.name.split("/").at(-1));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(artifactStore.open).toHaveBeenCalledWith({ applicationId: "qasey", tenantId: "public-test" }, entry);
  });

  it("serves a single byte range as a 206 stream and rejects an unsatisfiable range", async () => {
    const entry = { id: "video", name: "video.webm", kind: "video", contentType: "video/webm" };
    vi.mocked(runRepository.get).mockResolvedValue({ artifacts: [entry] } as never);
    vi.mocked(artifactStore.size).mockResolvedValue(3);
    vi.mocked(artifactStore.open).mockResolvedValue({ body: new Uint8Array([2, 3]), contentLength: 2 } as never);
    const requestContext = new RequestContext();
    requestContext.set("applicationId", "qasey");
    requestContext.set("identity", { tenantId: "public-test" });
    const route = apiRoutes.find(route => route.path === "/v1/case-hub/runs/:runId/artifacts/:artifactId")!;
    if (!("handler" in route) || !route.handler) throw new Error("Artifact route handler is missing");
    const responseFor = async (range: string) => {
      const headers = new Headers();
      return route.handler({
        get: () => requestContext,
        req: { param: (name: string) => name === "runId" ? "public-run" : entry.id, header: (name: string) => name === "range" ? range : undefined },
        header: (name: string, value: string) => headers.set(name, value),
        body: (body: BodyInit, status = 200) => new Response(body, { status, headers }),
        json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
      } as never, async () => undefined);
    };

    const partial = await responseFor("bytes=1-2");
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 1-2/3");
    expect(partial.headers.get("content-length")).toBe("2");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(new Uint8Array([2, 3]));
    expect(artifactStore.open).toHaveBeenCalledWith({ applicationId: "qasey", tenantId: "public-test" }, entry, { start: 1, end: 2 });

    vi.mocked(artifactStore.open).mockClear();
    const unsatisfiable = await responseFor("bytes=3-4");
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */3");
    expect(artifactStore.open).not.toHaveBeenCalled();
  });
});
