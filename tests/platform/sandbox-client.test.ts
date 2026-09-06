import { describe, expect, it, vi } from "vitest";
import { RemoteWorkspaceSandbox } from "../../src/platform/workspace/sandbox-client.ts";

describe("RemoteWorkspaceSandbox", () => {
  it("releases the durable pool lease when the workspace is destroyed", async () => {
    const resolveSession = vi.fn(() => Promise.reject(new Error("session should not be resolved directly")));
    const releaseSession = vi.fn(async () => undefined);
    const sandbox = new RemoteWorkspaceSandbox(resolveSession, releaseSession);

    await sandbox.destroy();

    expect(releaseSession).toHaveBeenCalledOnce();
    expect(resolveSession).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("destroyed");
  });
});
