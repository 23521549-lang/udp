import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // `kubectl kustomize` dựng overlay một lần cho cả tệp — vài giây trên máy chậm
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
