import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /** Bộ hợp đồng chạy in-process trên SimCloud; cùng trần mỗi phép với adapter-core */
    testTimeout: 5_000,
  },
});
