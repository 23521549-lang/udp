import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Hàm thuần và một server HTTP giả trong tiến trình: không chạm database.
    testTimeout: 10_000,
  },
});
