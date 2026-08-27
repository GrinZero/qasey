import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangedProjectPlaywrightVerificationSchema } from "../../packages/contracts/src/index.ts";
import { executionProfile } from "../../packages/code-task/src/index.ts";
import {
  webE2EConfigurationFromSkill,
  webE2EPlaywrightPlans,
  webE2ERepositoryFromSkill,
} from "../../src/platform/code-task/e2e-repository-skill.ts";

describe("fixed Web E2E repository execution configuration", () => {
  const configFile = new URL("../../config/e2e-repository.example.json", import.meta.url).pathname;

  it("uses the repository's real project paths", () => {
    expect(webE2ERepositoryFromSkill(configFile).allowedPaths).toEqual(expect.arrayContaining([
      "web/tests/e2e",
      "web/pages",
    ]));
  });

  it("loads the repository target and verification policy from one trusted snapshot", () => {
    const snapshot = webE2EConfigurationFromSkill(configFile);
    expect(snapshot.target.repository).toBe("web-e2e");
    expect(snapshot.verification.projects[0]).toMatchObject({
      root: "web",
      config: "web/playwright.config.ts",
    });
  });

  it("selects the affected Playwright project and narrows verification to changed specs", () => {
    expect(webE2EPlaywrightPlans([
      "web/pages/pets.ts",
      "web/tests/e2e/pets/create.spec.ts",
    ], configFile)).toEqual([{
      id: "web",
      config: "web/playwright.config.ts",
      playwrightProject: "chromium",
      testFiles: ["web/tests/e2e/pets/create.spec.ts"],
    }]);
  });

  it("runs the affected project when shared project code changes without a spec", () => {
    expect(webE2EPlaywrightPlans(["web/pages/requests.ts"], configFile)).toMatchObject([
      { id: "web", testFiles: [] },
    ]);
  });

  it("fails closed when changes do not belong to a configured project", () => {
    expect(() => webE2EPlaywrightPlans(["tests/unknown.spec.ts"], configFile)).toThrow(/not covered by a fixed Playwright project/u);
    expect(() => webE2EPlaywrightPlans([], configFile)).toThrow(/No fixed Playwright project/u);
  });

  it("fails closed when only some changed paths are covered", () => {
    expect(() => webE2EPlaywrightPlans([
      "web/pages/pets.ts",
      "outside/unverified.ts",
    ], configFile)).toThrow(/not covered by a fixed Playwright project/u);
  });

  it("rejects duplicate projects, traversal, and project paths outside their root", () => {
    const project = {
      id: "web",
      root: "web",
      testRoot: "web/tests",
      config: "web/playwright.config.ts",
      playwrightProject: "chromium",
    };
    expect(ChangedProjectPlaywrightVerificationSchema.safeParse({
      strategy: "changed-project-playwright",
      projects: [project, project],
    }).success).toBe(false);
    expect(ChangedProjectPlaywrightVerificationSchema.safeParse({
      strategy: "changed-project-playwright",
      projects: [{ ...project, config: "../playwright.config.ts" }],
    }).success).toBe(false);
    expect(ChangedProjectPlaywrightVerificationSchema.safeParse({
      strategy: "changed-project-playwright",
      projects: [{ ...project, testRoot: "other/tests" }],
    }).success).toBe(false);
    expect(ChangedProjectPlaywrightVerificationSchema.safeParse({
      strategy: "changed-project-playwright",
      projects: [{ ...project, testRoot: "web\\tests" }],
    }).success).toBe(false);
  });

  it("rejects a service configuration with writable paths outside fixed verification", () => {
    const directory = mkdtempSync(join(tmpdir(), "qasey-e2e-config-"));
    const target = join(directory, "repository.json");
    try {
      const parsed = JSON.parse(readFileSync(configFile, "utf8")) as { web: { target: { allowedPaths: string[] } } };
      parsed.web.target.allowedPaths.push("unverified/path");
      writeFileSync(target, JSON.stringify(parsed));
      expect(() => webE2EConfigurationFromSkill(target)).toThrow(/writable path must be covered/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps the Sandbox profile base URL name to the target repository name", () => {
    expect(executionProfile("web-e2e-verifier").environmentAliases).toEqual({ QASEY_E2E_BASE_URL: "BASE_URL" });
  });

  it("passes the configured model endpoint only to agent-backed profiles", () => {
    expect(executionProfile("web-e2e-author").allowedEnvironmentKeys).toEqual(expect.arrayContaining([
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
    ]));
    expect(executionProfile("web-e2e-repair").allowedEnvironmentKeys).toContain("OPENAI_BASE_URL");
    expect(executionProfile("code-review-readonly").allowedEnvironmentKeys).toContain("OPENAI_BASE_URL");
    expect(executionProfile("web-e2e-verifier").allowedEnvironmentKeys).not.toContain("OPENAI_BASE_URL");
  });
});
