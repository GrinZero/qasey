import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let workflow = "";
let manifest: { scripts?: Record<string, string> } = {};
let playwrightConfig = "";
let browserSuite = "";

beforeAll(async () => {
  [workflow, manifest, playwrightConfig, browserSuite] = await Promise.all([
    readFile(resolve(projectRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(resolve(projectRoot, "package.json"), "utf8").then(source => JSON.parse(source) as typeof manifest),
    readFile(resolve(projectRoot, "playwright.config.ts"), "utf8"),
    readFile(resolve(projectRoot, "tests/browser/admin-ui.spec.ts"), "utf8"),
  ]);
});

describe("Admin UI browser gate", () => {
  it("builds and serves the real Admin UI artifact before Playwright runs", () => {
    const command = manifest.scripts?.["test:browser"];
    expect(command).toContain("pnpm admin-ui:build");
    expect(command).toContain("playwright test --config=playwright.config.ts");
    expect(playwrightConfig).toContain("apps/admin-ui");
    expect(playwrightConfig).toContain("vite preview");
    expect(playwrightConfig).toContain("strictPort");
  });

  it("mocks authenticated APIs while exercising navigation, primary routes, and 404", () => {
    for (const endpoint of [
      "/admin/api/session",
      "/admin/api/catalog",
      "/admin/api/applications",
      "/v1/runs",
    ]) {
      expect(browserSuite).toContain(endpoint);
    }
    expect(browserSuite).toContain('page.on("pageerror"');
    expect(browserSuite).toContain("/admin/apps/qasey");
    expect(browserSuite).toContain("/admin/does-not-exist");
    expect(browserSuite).toContain("页面不存在");
  });

  it("runs after Chromium installation and retains failure-only trace and screenshots", () => {
    const installIndex = workflow.indexOf("name: Install Chromium");
    const browserIndex = workflow.indexOf("name: Run Admin UI browser gate");
    const uploadIndex = workflow.indexOf("name: Upload Admin UI browser failure evidence");
    expect(installIndex).toBeGreaterThan(-1);
    expect(browserIndex).toBeGreaterThan(installIndex);
    expect(uploadIndex).toBeGreaterThan(browserIndex);
    expect(workflow.slice(browserIndex, uploadIndex)).toContain("run: pnpm test:browser");
    expect(workflow.slice(uploadIndex)).toContain("if: ${{ failure() }}");
    expect(workflow.slice(uploadIndex)).toContain("path: output/playwright/");
    expect(playwrightConfig).toContain('trace: "retain-on-failure"');
    expect(playwrightConfig).toContain('screenshot: "only-on-failure"');
  });

  it("keeps workflow actions immutable and permissions read-only", () => {
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s+\S+@([^\s]+)(?:\s+#.*)?$/gmu)]
      .map(([, reference]) => reference)
      .filter((reference): reference is string => Boolean(reference));
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every(reference => /^[a-f0-9]{40}$/u.test(reference))).toBe(true);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toMatch(/^\s+(?:actions|attestations|contents|id-token|packages|security-events):\s+write\s*$/gmu);
  });
});
