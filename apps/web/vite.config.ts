import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@blh/web-client": path.resolve(root, "../../packages/web-client/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8123",
        changeOrigin: true,
      },
    },
  },
  build: {
    // 产出到根 dist/web，与 server/index.ts 的 staticDir() 对齐
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
