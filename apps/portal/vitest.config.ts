import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
    /**
     * `css: false` — jsdom không chạy layout, nên CSS không đổi kết quả của bất kỳ phép
     * kiểm nào ở đây; layout thật đo ở cổng Playwright `portal-demo` (`demo/screens.pw.ts`, Plan #53).
     */
    css: false,
    testTimeout: 15_000,
  },
});
