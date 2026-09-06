import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: [{ find: /^@\//u, replacement: `${fileURLToPath(new URL("./src", import.meta.url))}/` }],
  },
  build: {
    target: "es2022",
    cssMinify: true,
    sourcemap: false,
  },
  server: {
    port: 4173,
    proxy: {
      "/studio/api": "http://localhost:4111",
      "/admin/api": "http://localhost:4111",
      "/v1": "http://localhost:4111",
    },
  },
});
