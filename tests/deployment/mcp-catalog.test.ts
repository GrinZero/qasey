import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("deployment MCP catalogue", () => {
  it("ships the tracked MeterSphere catalogue in the runtime image", async () => {
    const [dockerfile, dockerignore, catalogueText] = await Promise.all([
      readFile(resolve(projectRoot, "Dockerfile"), "utf8"),
      readFile(resolve(projectRoot, ".dockerignore"), "utf8"),
      readFile(resolve(projectRoot, ".qasey/mcp.json"), "utf8"),
    ]);
    const catalogue = JSON.parse(catalogueText) as { servers?: Record<string, unknown> };

    expect(catalogue.servers).toHaveProperty("metersphere");
    expect(dockerignore).toContain("!.qasey/mcp.json");
    expect(dockerfile).toContain("COPY --from=build /app/.qasey/mcp.json ./.qasey/mcp.json");
    expect(dockerfile).not.toMatch(/printf[^\n]+\{["']?servers["']?:\{\}\}/u);
  });
});
