import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/smoke/**", "tests/integration/**", "node_modules"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/db/seed.ts", "src/index.ts"],
    },
  },
});
