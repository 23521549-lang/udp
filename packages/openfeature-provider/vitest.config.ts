import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Test tích hợp dựng Service 2 bằng tiến trình con trên cùng database dùng
    // chung — tuần tự, như test của các service (trần kết nối Supabase)
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
