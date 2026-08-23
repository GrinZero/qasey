import { mkdtemp, rm, cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PlaywrightRunner } from "../../packages/e2e/src/index.ts";

describe("Playwright vertical slice", () => {
  it("runs a real browser test and exposes report, trace, screenshot, and log evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-playwright-"));
    try {
      await cp(resolve("tests/fixtures/playwright-smoke"), root, { recursive: true });
      await mkdir(join(root, "artifacts"), { recursive: true });
      const result = await new PlaywrightRunner().run({
        id: "smoke", root, gitDir: join(root, ".git"), branch: "qasey/smoke",
        baseSha: "0123456789abcdef0123456789abcdef01234567", purpose: "verifier",
        repository: { owner: "local", repository: "smoke", cloneUrl: root, baseRef: "main", allowedPaths: ["."], skillsPaths: [] },
      }, "smoke");
      expect(result.passed, result.summary).toBe(true);
      expect(result.artifacts.map(item => item.kind)).toEqual(expect.arrayContaining(["report", "trace", "screenshot", "log"]));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);
});
