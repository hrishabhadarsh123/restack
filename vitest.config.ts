import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // E2E fixture-heavy tests can take a moment
    testTimeout: 30_000,
  },
});
