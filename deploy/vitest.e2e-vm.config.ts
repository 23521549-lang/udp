import { defineConfig } from "vitest/config";

/**
 * E2E của máy ảo (Plan #52) — cần máy diễn tập mà job `vm` của CI dựng (`bootstrap.sh` + `release.sh`), nên KHÔNG
 * nằm trong `test`. Tuần tự: kiểm tra sau cùng khôi phục database.
 */
export default defineConfig({
  test: {
    include: ["e2e-vm/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 240_000,
  },
});
