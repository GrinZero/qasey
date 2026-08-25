import { describe, expect, it } from "vitest";
import { executionProfile } from "../../packages/code-task/src/index.ts";
import { webE2EPlaywrightPlans, webE2ERepositoryFromSkill } from "../../src/platform/code-task/e2e-repository-skill.ts";

describe("fixed Web E2E repository execution configuration", () => {
  it("uses the repository's real project paths", () => {
    expect(webE2ERepositoryFromSkill().allowedPaths).toEqual(expect.arrayContaining([
      "project/BWeb/tests",
      "project/OBC/tests",
      "project/enterprise/tests",
    ]));
  });

  it("selects the affected Playwright project and narrows verification to changed specs", () => {
    expect(webE2EPlaywrightPlans([
      "project/BWeb/pages/pets.ts",
      "project/BWeb/tests/pets/create.spec.ts",
    ])).toEqual([{
      id: "bweb",
      config: "project/BWeb/playwright.config.ts",
      playwrightProject: "t2",
      testFiles: ["project/BWeb/tests/pets/create.spec.ts"],
    }]);
  });

  it("runs the affected project when shared project code changes without a spec", () => {
    expect(webE2EPlaywrightPlans(["project/OBC/pages/requests.ts"])).toMatchObject([
      { id: "obc", testFiles: [] },
    ]);
  });

  it("fails closed when changes do not belong to a configured project", () => {
    expect(() => webE2EPlaywrightPlans(["tests/unknown.spec.ts"])).toThrow(/No fixed Playwright project/u);
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
