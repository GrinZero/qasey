import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  base: "/admin/",
  plugins: [react(), viteSingleFile()],
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
