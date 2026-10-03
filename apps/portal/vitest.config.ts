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
    /**
     * [Plan #55] Tối đa 4 worker. Mặc định vitest mở (số lõi − 1) worker jsdom — 15 trên máy 16 luồng mà chỉ
     * 8 GiB RAM — và máy thiếu RAM làm các ô có debounce hay nhiều bước quá hạn chờ: đo 30/09 ở lượt đầy đủ, 1–3
     * ô đỏ khác nhau mỗi lần, xanh khi chạy riêng. Với 4 worker: 227/227 xanh và NHANH hơn (35 giây so với 47).
     * Runner CI có 4 lõi nên vốn chạy 3 worker — giới hạn này không đổi gì ở đó.
     */
    maxWorkers: 4,
    minWorkers: 1,
  },
});
