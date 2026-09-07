import { cp, mkdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("playwright-core/package.json"));
const target = resolve(process.argv[2] ?? "dist/trace-viewer");
await mkdir(target, { recursive: true });
await cp(resolve(packageRoot, "lib/vite/traceViewer"), target, { recursive: true });
await copyFile(resolve(packageRoot, "LICENSE"), resolve(target, "LICENSE"));
await copyFile(resolve(packageRoot, "NOTICE"), resolve(target, "NOTICE"));
