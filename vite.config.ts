import { defineConfig } from "vitest/config";
import { localApi } from "./src/server/vite-plugin.ts";

export default defineConfig({
  plugins: [localApi()],
  build: {
    outDir: "dist",
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
