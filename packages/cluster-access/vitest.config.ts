import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Vận chuyển tiêm vào: không cluster, không mạng
    testTimeout: 10_000,
  },
});
