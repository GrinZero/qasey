import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runtimeEnvironment, runtimeEnvFiles } from "../src/load-env.ts";

describe("runtime env files", () => {
  it("selects the checked-in environment file from the Kubernetes namespace", () => {
    expect(runtimeEnvironment({ NAMESPACE: "ns-testing" } as NodeJS.ProcessEnv)).toBe("testing");
    expect(runtimeEnvFiles({ NAMESPACE: "ns-testing" } as NodeJS.ProcessEnv)).toEqual([
      ".env",
      ".env.testing",
      ".env.secret",
      ".env.local",
      ".env.testing.local",
      ".env.secret.local",
    ]);
  });

  it("uses testing as the local default environment", () => {
    expect(runtimeEnvironment({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(runtimeEnvFiles({} as NodeJS.ProcessEnv)).toEqual([
      ".env",
      ".env.testing",
      ".env.secret",
      ".env.local",
      ".env.testing.local",
      ".env.secret.local",
    ]);
  });

  it("keeps non-secret runtime configuration out of generated secrets", () => {
    const envConfig = JSON.parse(
      readFileSync(new URL("../ci/env.json", import.meta.url), "utf8"),
    ) as { env: Record<string, string> };
    const sharedEnv = readFileSync(new URL("../.env", import.meta.url), "utf8");

    expect(envConfig.env).not.toHaveProperty("EDITOR_DATABASE_URL");
    expect(envConfig.env).not.toHaveProperty("JIRA_EMAIL");
    expect(envConfig.env).not.toHaveProperty("GOOGLE_CLIENT_ID");
    expect(sharedEnv).toMatch(/^EDITOR_DATABASE_URL=/m);
    expect(sharedEnv).toMatch(/^JIRA_EMAIL=\S+$/m);
    expect(sharedEnv).toMatch(/^GOOGLE_CLIENT_ID=/m);
  });
});
