import { defineConfig } from "vitest/config";

/**
 * Smoke-test-only vitest config.
 * Used by `pnpm test:smoke` — targets the hosted Railway endpoint.
 * Excludes nothing so tests/smoke/ is always picked up.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/smoke/**/*.test.ts"],
    testTimeout: 30_000, // generous timeout for Railway cold starts
  },
});
