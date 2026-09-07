import { describe, expect, it, vi } from "vitest";
import { startContainerDevelopment, validateContainerSandboxEnvironment } from "../../scripts/dev-container.ts";

describe("container development launcher", () => {
  it("waits for the Compose stack before running the dev command in its container", () => {
    const run = vi.fn(() => 0);
    expect(startContainerDevelopment(run, false)).toBe(0);
    expect(run.mock.calls).toEqual([
      [["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", "up", "--build", "-d", "development"]],
      [["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", "exec", "-T", "--user", "node", "development", "pnpm", "dev:container"]],
    ]);
  });

  it("does not launch Mastra after a failed infrastructure startup", () => {
    const run = vi.fn(() => 17);
    expect(startContainerDevelopment(run, false)).toBe(17);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("preserves the interactive terminal and propagates the dev process exit status", () => {
    const run = vi.fn(() => 0).mockReturnValueOnce(0).mockReturnValueOnce(130);
    expect(startContainerDevelopment(run, true)).toBe(130);
    expect(run).toHaveBeenLastCalledWith(expect.not.arrayContaining(["-T"]));
  });

  it("reports how to repair an old container without generating mismatched keys", () => {
    expect(() => validateContainerSandboxEnvironment({ QASEY_SANDBOX_CONTROL_KEY: " " }))
      .toThrow(/QASEY_SANDBOX_CONTROL_KEY, QASEY_SANDBOX_LEASE_KEY.*Rebuild Container/u);
  });

  it("preserves custom Compose keys without printing them on configuration errors", () => {
    const env = {
      QASEY_SANDBOX_CONTROL_KEY: "synthetic-control-key-from-compose",
      QASEY_SANDBOX_LEASE_KEY: "synthetic-lease-key-from-compose",
    };
    const before = { ...env };
    expect(() => validateContainerSandboxEnvironment(env)).not.toThrow();
    expect(env).toEqual(before);
    try {
      validateContainerSandboxEnvironment({ ...env, QASEY_SANDBOX_LEASE_KEY: "" });
      expect.fail("Missing lease key should fail validation");
    } catch (error) {
      expect(String(error)).toContain("QASEY_SANDBOX_LEASE_KEY");
      expect(String(error)).not.toContain(env.QASEY_SANDBOX_CONTROL_KEY);
    }
  });
});
