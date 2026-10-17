import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/env.ts"],
    // los tests de base comparten radar_urbano_test: se corren en serie
    fileParallelism: false,
    testTimeout: 20000,
  },
});
