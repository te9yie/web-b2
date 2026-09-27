import { defineConfig, devices } from "@playwright/test";
import { MUTABLE_ROOT } from "./e2e/global-setup";

const port = 5199;
// 書き換えるテスト用。fixtures/ を e2e/.data に写したものを KB_ROOT にする（global-setup.ts）
const mutablePort = 5197;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  projects: [
    {
      name: "chromium",
      testIgnore: /mutating\//,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${port}` },
    },
    {
      // ファイルを書き換えるテスト。fixtures/ を共有しないよう別のサーバーで、順に動かす
      name: "mutating",
      testMatch: /mutating\/.*\.spec\.ts/,
      fullyParallel: false,
      workers: 1,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${mutablePort}` },
    },
  ],
  webServer: [
    {
      command: `npm run dev:local -- --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      env: { KB_ROOT: "fixtures" },
    },
    {
      command: `npm run dev:local -- --port ${mutablePort} --strictPort`,
      url: `http://localhost:${mutablePort}`,
      reuseExistingServer: !process.env.CI,
      env: { KB_ROOT: MUTABLE_ROOT },
    },
  ],
});
