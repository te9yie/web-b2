// `npm run perf` 用。src の単体テストとは別に perf/ の計測だけを回す
import { defineConfig } from "vitest/config";
import base from "../vite.config.ts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["perf/**/*.perf.ts"],
    testTimeout: 600000,
    hookTimeout: 600000,
    // console の出力をそのまま出す
    silent: false,
  },
});
