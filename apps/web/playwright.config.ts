import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
  },
  webServer: [
    {
      command: "pnpm --filter @blh/web dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: true,
    },
    {
      command: "node e2e/mock-server.mjs",
      url: "http://127.0.0.1:8123/api/session",
      reuseExistingServer: false,
    },
  ],
});
