import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /**
     * Chay tuan tu tu dau, khong doi toi luc do oan.
     *
     * Supabase free tier co tran 60 ket noi, va `pnpm test` da chay song song
     * bon package. Do duoc: nen hien tai ~18 ket noi, moi worker vitest cua mot
     * service mo mot pool rieng. De vitest fork tu do o day la mua lay nhung
     * lan do NGAU NHIEN o file khac nhau moi lan chay — dung loai do oan day
     * nguoi ta bo qua test.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
