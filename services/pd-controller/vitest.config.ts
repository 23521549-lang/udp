import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /**
     * Chạy tuần tự như hai service kia: test tích hợp mở pool riêng tới Supabase,
     * và một số file còn dựng Service 2 bằng tiến trình con.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
