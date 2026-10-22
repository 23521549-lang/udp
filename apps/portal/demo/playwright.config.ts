import { defineConfig } from "@playwright/test";

/**
 * [Plan #53 QĐ-11] Cổng chụp màn của bản xem thử: Playwright mở bản build tĩnh (`demo:build`) và đi qua mọi màn
 * ở hai cỡ khung. Không so pixel — font khác máy làm đỏ giả; thứ được kiểm là thứ máy kiểm chắc được (lỗi
 * console, tràn ngang, cấu trúc trang, chữ). Ảnh chụp để người xem, không để so.
 *
 * Ở CI: Chromium do `playwright install` tải trong runner. Ở máy dev: Edge sẵn có (`msedge`), không tải thêm
 * trình duyệt nào.
 *
 *   pnpm --filter @udp/portal demo:build && pnpm --filter @udp/portal demo:screens
 */
const PORT = 4174;

export default defineConfig({
  testDir: ".",
  testMatch: /screens\.pw\.ts$/,
  outputDir: "screens/results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
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
