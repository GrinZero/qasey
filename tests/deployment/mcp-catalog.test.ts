import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("deployment MCP catalogue", () => {
  it("ships the business-owned catalogue at a path outside infrastructure mounts", async () => {
    const [dockerfile, dockerignore, environment, catalogueText] = await Promise.all([
      readFile(resolve(projectRoot, "Dockerfile"), "utf8"),
      readFile(resolve(projectRoot, ".dockerignore"), "utf8"),
      readFile(resolve(projectRoot, ".env.example"), "utf8"),
      readFile(resolve(projectRoot, "config/mcp.example.json"), "utf8"),
    ]);
    const catalogue = JSON.parse(catalogueText) as { servers?: Record<string, unknown> };

    expect(catalogue.servers).toHaveProperty("metersphere");
    expect(dockerignore).not.toContain("!.qasey/mcp.json");
    expect(environment).toContain("QASEY_MCP_CONFIG_FILE=config/mcp.json");
    expect(dockerfile).toContain("COPY --from=build /app/config ./config");
    expect(dockerfile).not.toMatch(/printf[^\n]+\{["']?servers["']?:\{\}\}/u);
  });
});
