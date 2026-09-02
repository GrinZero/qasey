import { describe, expect, it, vi } from "vitest";
import { runSafeCommand } from "../../packages/e2e/src/process.ts";

describe("E2E process environment", () => {
  it("passes the shared Playwright browser path to child processes", async () => {
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "/ms-playwright");
    try {
      const result = await runSafeCommand({
        executable: process.execPath,
        args: ["-e", "process.stdout.write(process.env.PLAYWRIGHT_BROWSERS_PATH || '')"],
        cwd: process.cwd(),
      });

      expect(result).toMatchObject({ exitCode: 0, stdout: "/ms-playwright" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
