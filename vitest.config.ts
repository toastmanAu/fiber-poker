import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
            "tests/engine/**/*.test.ts",
            "tests/protocol/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "tests/fiber/**/*.test.ts",
            "tests/integration/**/*.test.ts",
            "tests/chaos/**/*.test.ts",
          ],
          environment: "node",
          // Integration suites drive real server processes and timers.
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Run each integration/chaos file alone to avoid port/timing cross-talk.
          fileParallelism: false,
          maxConcurrency: 1,
        },
      },
    ],
  },
});
