import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("Mastra filesystem-agent build patch", () => {
  it("accepts the generated filesystem-agent wrapper as a valid Mastra export", async () => {
    const patch = await readFile(
      resolve(projectRoot, "patches/@mastra__deployer@1.64.0.patch"),
      "utf8",
    );

    expect(patch).toContain("dist/analyze-z37DoML5.js");
    expect(patch).toContain("dist/analyze-IM-jyN5x.cjs");
    expect(patch.match(/isFsAgentWrapper/g)).toHaveLength(4);
  });
});
