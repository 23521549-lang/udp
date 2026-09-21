import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /**
     * Test golden hash chạm database thật (Supabase, trần 60 kết nối) — tuần tự
     * từng file như các service, cùng lý do ghi ở `services/flag-service`.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
