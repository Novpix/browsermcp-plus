import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "node_modules/**"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
  },
});
