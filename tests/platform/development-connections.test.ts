import { describe, expect, it, vi } from "vitest";
import { closeDevelopmentConnections } from "../../src/platform/http/development-connections.ts";

describe("development HTTP connections", () => {
  it("closes responses so a dev-server restart cannot strand Chrome's origin pool", async () => {
    const header = vi.fn();
    const next = vi.fn(async () => undefined);
    const handler = closeDevelopmentConnections as Exclude<typeof closeDevelopmentConnections, { path: string }>;

    await handler({ header } as never, next);

    expect(header).toHaveBeenCalledWith("Connection", "close");
    expect(next).toHaveBeenCalledOnce();
  });
});
