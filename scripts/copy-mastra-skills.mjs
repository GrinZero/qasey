import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(projectRoot, "src/mastra/skills");
const targets = [
  resolve(projectRoot, ".mastra/output/skills"),
  resolve(projectRoot, ".mastra/worker/skills"),
];

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}
