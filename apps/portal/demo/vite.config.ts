import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Build bản xem thử của Portal (`demo/`): trang tĩnh chạy được ở bất kỳ đâu — đường dẫn tài nguyên tương đối, MỘT
 * tệp JS (không chunk tải động) để publish như một trang Artifact.
 *
 *   npx vite build --config demo/vite.config.ts        (trong apps/portal)
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: "./",
  plugins: [react()],
  // Mẫu response golden nằm ở services/core-backend — ngoài gốc của Vite
  server: { fs: { allow: [resolve(here, "../../..")] } },
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    // Cố ý MỘT tệp JS (trang Artifact không tải chunk động) — ngưỡng cảnh báo theo đó
    chunkSizeWarningLimit: 1_200,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
