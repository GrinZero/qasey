import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "mcp-login": "apps/cli/src/mcp-login.ts",
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
  ],
  outExtension: () => ({ js: ".mjs" }),
});
