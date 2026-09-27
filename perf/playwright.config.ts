// `npm run perf:e2e` 用。合成データ1万ページを perf/.data に書き出し、それを KB_ROOT にしてブラウザの起動時間を測る
import { defineConfig, devices } from "@playwright/test";

const port = 5198;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.perf\.spec\.ts/,
  globalSetup: "./global-setup.ts",
  timeout: 600000,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${port}`,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev:local -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    env: { KB_ROOT: "perf/.data" },
  },
});
