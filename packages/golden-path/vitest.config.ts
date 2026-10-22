import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test của CHÍNH template Node chạy ở đây — mẫu phát cho developer là mẫu đã chạy xanh
    include: ["tests/**/*.test.ts", "templates/node/tests/**/*.test.ts"],
  },
});
