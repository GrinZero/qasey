import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
import { readFile } from "node:fs/promises";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); });

it("serves rebuilt HTML on the next development request", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.mocked(readFile).mockResolvedValueOnce("first build").mockResolvedValueOnce("updated build");
  const { loadAdminUiHtml } = await import("../../src/platform/admin-ui/shell.ts");
  await expect(loadAdminUiHtml()).resolves.toBe("first build");
  await expect(loadAdminUiHtml()).resolves.toBe("updated build");
});

it("keeps immutable production HTML cached", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.mocked(readFile).mockResolvedValue("production build");
  const { loadAdminUiHtml } = await import("../../src/platform/admin-ui/shell.ts");
  await expect(loadAdminUiHtml()).resolves.toBe("production build");
  await expect(loadAdminUiHtml()).resolves.toBe("production build");
  expect(readFile).toHaveBeenCalledTimes(1);
});
