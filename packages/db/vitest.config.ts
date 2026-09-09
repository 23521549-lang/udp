import { defineConfig } from "vitest/config";

/**
 * Test bất biến chạy trên DATABASE THẬT, không mock.
 *
 * Lý do: thứ đang được kiểm là hành vi của Postgres — GRANT, trigger, partial
 * index, thứ tự cascade. Mock chúng nghĩa là kiểm chính giả định của mình, mà
 * giả định sai là đúng loại lỗi bộ test này sinh ra để bắt. §13.3 gọi đây là
 * "cưỡng chế được database kiểm, không phải code review".
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Mỗi test tự mở kết nối tới Supabase; chạy song song sẽ vượt trần
    // connection của gói free (60), nên chạy tuần tự.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
