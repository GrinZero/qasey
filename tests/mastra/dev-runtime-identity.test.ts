import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDevRuntimeId } from "../../src/mastra/applications/qasey/dev-runtime-identity.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("development runtime identity", () => {
  it("persists the runtime id across hot-reloaded server processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qasey-runtime-id-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runtime-id");

    const first = resolveDevRuntimeId(undefined, path);
    const second = resolveDevRuntimeId(undefined, path);

    expect(first).toMatch(/^local-[A-Z2-9]{8}$/u);
    expect(second).toBe(first);
    await expect(readFile(path, "utf8")).resolves.toBe(`${first}\n`);
  });

  it("prefers an explicitly configured runtime id", () => {
    expect(resolveDevRuntimeId("local-ABCDEFG2", "/does/not/matter")).toBe("local-ABCDEFG2");
  });
});
