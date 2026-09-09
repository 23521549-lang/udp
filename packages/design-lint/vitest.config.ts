import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Vài test mở kết nối tới Supabase; gói free chỉ có 60 connection.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
