import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Test property-based chay hang chuc nghin mau, khong cham database.
    testTimeout: 30_000,
  },
});
