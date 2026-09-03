import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeEnvLoadReport, loadRuntimeEnv, resolveRuntimeEnvRoot, runtimeEnvironment, runtimeEnvFiles } from "../src/load-env.ts";

describe("runtime env files", () => {
  it("selects standard environment-specific files from NODE_ENV", () => {
    expect(runtimeEnvironment({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("test");
    expect(runtimeEnvFiles({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toEqual([
      ".env",
      ".env.test",
      ".env.local",
      ".env.test.local",
    ]);
  });

  it("uses development as the local default environment", () => {
    expect(runtimeEnvironment({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(runtimeEnvFiles({} as NodeJS.ProcessEnv)).toEqual([
      ".env",
      ".env.development",
      ".env.local",
      ".env.development.local",
    ]);
  });

  it("rejects non-standard NODE_ENV values before resolving file paths", () => {
    expect(() => runtimeEnvFiles({ NODE_ENV: "../../private" } as NodeJS.ProcessEnv)).toThrow(/NODE_ENV/u);
    expect(() => loadRuntimeEnv({ env: {}, defaultEnvironment: "../../private" })).toThrow(/NODE_ENV/u);
  });

  it("reports env load order and precedence without logging values", () => {
    const report = createRuntimeEnvLoadReport({
      environment: "test",
      loadedFiles: ["/workspace/.env", "/workspace/.env.test", "/workspace/.env.local"],
      parsed: { EXISTING_KEY: "do-not-log", NEW_KEY: "also-do-not-log" },
    }, new Set(["EXISTING_KEY"]), "/workspace");

    expect(report).toMatchObject({
      environment: "test",
      candidateFiles: [
        ".env",
        ".env.test",
        ".env.local",
        ".env.test.local",
      ],
      loadedFiles: [".env", ".env.test", ".env.local"],
      skippedFiles: [".env.test.local"],
      existingProcessEnvPrecedence: "highest",
      filePrecedence: "later-file-wins",
      parsedKeyCount: 2,
      appliedKeyCount: 1,
      preservedProcessKeyCount: 1,
      valuesLogged: false,
    });
    expect(JSON.stringify(report)).not.toContain("do-not-log");
  });

  it("loads later files while preserving values already supplied by the process", () => {
    const cwd = mkdtempSync(join(tmpdir(), "qasey-env-"));
    writeFileSync(join(cwd, ".env"), "FROM_FILE=base\nPRESERVED=file\n", "utf8");
    writeFileSync(join(cwd, ".env.development"), "FROM_FILE=environment\n", "utf8");
    const env = { PRESERVED: "process" } as NodeJS.ProcessEnv;

    const result = loadRuntimeEnv({ env, cwd });

    expect(env).toMatchObject({ FROM_FILE: "environment", PRESERVED: "process" });
    expect(result.loadedFiles).toHaveLength(2);
  });

  it("discovers env files from a generated Mastra process below the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "qasey-env-root-"));
    const generatedDirectory = join(root, ".mastra", "output", "public");
    mkdirSync(generatedDirectory, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "qasey" }), "utf8");
    writeFileSync(join(root, ".env.local"), "GITHUB_TOKEN=synthetic-personal-access-token-at-least-32-bytes\n", "utf8");
    const env = { NODE_ENV: "development", INIT_CWD: generatedDirectory } as NodeJS.ProcessEnv;

    expect(resolveRuntimeEnvRoot(env, generatedDirectory)).toBe(root);
    const result = loadRuntimeEnv({ env });

    expect(env.GITHUB_TOKEN).toBe("synthetic-personal-access-token-at-least-32-bytes");
    expect(result.loadedFiles).toEqual([join(root, ".env.local")]);
  });

  it("ships only redacted runtime configuration examples", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/^DATABASE_URL=/m);
    expect(example).toMatch(/^OPENAI_API_KEY=$/m);
    expect(example.toLowerCase()).not.toContain(["moe", "go"].join(""));
  });
});
