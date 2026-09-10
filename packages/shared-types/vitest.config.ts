import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Hàm thuần: không chạm database, không mạng.
    testTimeout: 10_000,
  },
});
