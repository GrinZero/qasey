import { afterEach, describe, expect, it, vi } from "vitest";
import { McpToolDiscoveryCache } from "../../packages/adapters/src/mcp.ts";

const result = (name: string) => ({ tools: { [name]: { description: name } }, errors: {} });

describe("MCP tool discovery cache", () => {
  afterEach(() => vi.useRealTimers());

  it("shares one initial discovery across concurrent callers", async () => {
    let resolve!: (value: ReturnType<typeof result>) => void;
    const pending = new Promise<ReturnType<typeof result>>(done => { resolve = done; });
    const client = { listToolsWithErrors: vi.fn(() => pending) };
    const cache = new McpToolDiscoveryCache({ initialWaitMs: 1_000 });

    const first = cache.get(client as never);
    const second = cache.get(client as never);
    resolve(result("one"));

    await expect(Promise.all([first, second])).resolves.toEqual([result("one"), result("one")]);
    expect(client.listToolsWithErrors).toHaveBeenCalledOnce();
  });

  it("serves stale tools immediately while refreshing in the background", async () => {
    let now = 0;
    let resolveRefresh!: (value: ReturnType<typeof result>) => void;
    const client = {
      listToolsWithErrors: vi.fn()
        .mockResolvedValueOnce(result("old"))
        .mockImplementationOnce(() => new Promise(done => { resolveRefresh = done; })),
    };
    const cache = new McpToolDiscoveryCache({ successTtlMs: 10, now: () => now });
    await expect(cache.get(client as never)).resolves.toEqual(result("old"));

    now = 11;
    await expect(cache.get(client as never)).resolves.toEqual(result("old"));
    expect(client.listToolsWithErrors).toHaveBeenCalledTimes(2);

    resolveRefresh(result("new"));
    await vi.waitFor(async () => expect(await cache.get(client as never)).toEqual(result("new")));
  });

  it("bounds the first request while discovery continues", async () => {
    vi.useFakeTimers();
    let resolve!: (value: ReturnType<typeof result>) => void;
    const client = {
      listToolsWithErrors: vi.fn(() => new Promise<ReturnType<typeof result>>(done => { resolve = done; })),
    };
    const cache = new McpToolDiscoveryCache({ initialWaitMs: 50 });
    const first = cache.get(client as never);

    await vi.advanceTimersByTimeAsync(50);
    await expect(first).resolves.toEqual({
      tools: {}, errors: { discovery: "Tool discovery is still warming in the background" },
    });

    resolve(result("ready"));
    await vi.runAllTimersAsync();
    await expect(cache.get(client as never)).resolves.toEqual(result("ready"));
  });
});
