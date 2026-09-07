import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Execute the workflow's real nested shell quoting. The Docker shim forwards
// to sh, and pnpm validates the manifest while deliberately emitting progress.
describe("sandbox smoke repository initialization", () => {
  for (const workflowName of ["ci", "release"]) {
    it(`${workflowName} creates valid JSON and captures only the Git SHA`, async () => {
      const root = await mkdtemp(join(tmpdir(), "qasey-smoke-shell-"));
      try {
        const workflow = await readFile(`.github/workflows/${workflowName}.yml`, "utf8");
        const start = workflow.indexOf('          base_sha="$(docker exec');
        const end = workflow.indexOf('          [[ "$base_sha"', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const fixture = join(root, "isolation.spec.js");
        await writeFile(fixture, "// public isolation fixture\n");
        await writeFile(join(root, "docker"), '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
        await writeFile(join(root, "pnpm"), `#!/bin/sh
exec "${process.execPath}" -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (manifest.private !== true || manifest.packageManager !== "pnpm@11.21.0") process.exit(1);
fs.writeFileSync("pnpm-lock.yaml", "lockfileVersion: 9.0\\n");
console.log("Synthetic pnpm install progress");
'
`, { mode: 0o755 });
        const snippet = workflow.slice(start, end)
          .replaceAll("/tmp/sandbox-isolation-smoke.spec.js", fixture)
          .replaceAll("/tmp/qasey-smoke-origin.git", join(root, "origin.git"));
        const stdout = execFileSync("bash", ["-eu", "-c", `${snippet}\nprintf '%s' "$base_sha"`], {
          cwd: root,
          env: { ...process.env, container_id: "synthetic-container", TMPDIR: root, PATH: `${root}:${process.env.PATH}` },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(stdout).toMatch(/^[a-f0-9]{40,64}$/u);
        const manifest = execFileSync("git", ["--git-dir", join(root, "origin.git"), "show", `${stdout}:package.json`], { encoding: "utf8" });
        expect(JSON.parse(manifest)).toEqual({ private: true, packageManager: "pnpm@11.21.0" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
