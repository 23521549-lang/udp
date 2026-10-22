import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Proxy `/api` sang Service 1 (§10.10): cùng origin với Portal thì cookie httpOnly
 * (`udp_access`, `udp_refresh`) đi kèm mà không cần CORS có credentials. Cổng 3001 là
 * cổng thật của Core Backend (README) — bản mẫu §10.10 ghi 3000 là cổng cũ.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
  /**
   * [Plan #60 QĐ-9] `manifest`: `scripts/prerender.mjs` tìm CSS và chunk của trang giới thiệu theo tên nguồn để gắn
   * vào `index.html` đã dựng sẵn (CSS của chunk lười chỉ nạp khi JS chạy — trang dựng sẵn cần nó ngay).
   */
  build: { sourcemap: true, manifest: true },
});
