import { defineConfig } from "@playwright/test";

/**
 * [Plan #59] Chụp lại ảnh của trang giới thiệu từ bản build tĩnh của bản xem thử (`landing-shots.pw.ts`). Tách khỏi
 * cổng `playwright.config.ts`: đây là việc sinh tệp, chạy khi giao diện đổi, không phải phép kiểm của mỗi lần build.
 *
 *   pnpm --filter @udp/portal demo:build && pnpm --filter @udp/portal demo:shots
 */
const PORT = 4175;

export default defineConfig({
  testDir: ".",
  testMatch: /landing-shots\.pw\.ts$/,
  outputDir: "screens/results",
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}/`,
    ...(process.env.CI === undefined ? { channel: "msedge" } : {}),
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
  },
  webServer: {
    command: `npx vite preview --config demo/vite.config.ts --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
    cwd: "..",
    url: `http://127.0.0.1:${String(PORT)}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
