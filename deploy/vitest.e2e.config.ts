import { defineConfig } from "vitest/config";

/**
 * E2E rút gọn (Plan #50) — cần một cụm đang chạy (`pnpm deploy:up`), nên KHÔNG nằm trong `test`. CI chạy nó ở
 * job `kind` sau khi dựng cụm; tuần tự, vì các kiểm tra đổi trạng thái của cùng một env seed.
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
