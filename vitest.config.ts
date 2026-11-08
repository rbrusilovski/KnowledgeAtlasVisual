import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = { "@": path.resolve(import.meta.dirname, "src") };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node", setupFiles: ["tests/setup-env.ts"] },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/setup-env.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          testTimeout: 120_000,
          hookTimeout: 300_000,
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
