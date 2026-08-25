import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "mcp-login": "apps/cli/src/mcp-login.ts",
    "gh-wrapper": "apps/cli/src/gh-wrapper.ts",
    "sandbox-runtime": "src/sandbox/main.ts",
    "code-task-worker": "src/sandbox/code-task-worker.ts",
    "cua-driver-worker": "src/sandbox/cua-driver-worker.ts",
  },
  format: ["esm"],
  target: "es2024",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  external: [
    "@duckdb/node-bindings",
    "dd-trace",
    "@datadog/native-metrics",
    "@datadog/native-appsec",
    "@datadog/native-iast-taint-tracking",
    "@datadog/pprof",
    "@trycua/cua-driver",
  ],
  outExtension: () => ({ js: ".mjs" }),
});
