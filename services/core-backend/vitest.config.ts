import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /**
     * Chay tuan tu, giong packages/db va flag-service.
     *
     * Truoc khi co service thu hai, de vitest fork tu do o day van an toan. Voi
     * sau package cung chay qua `pnpm -r`, mot lan chay day du da lam MOT test
     * do ngau nhien roi lan sau lai xanh — trieu chung cua canh tranh ket noi,
     * khong phai cua loi logic. Tran cua Supabase free tier la 60.
     */
    fileParallelism: false,
    /**
     * 5 giay mac dinh la qua chat cho bo nay.
     *
     * Day la test TICH HOP that: moi `newActor()` goi `POST /auth/register',
     * tuc mot lan bcrypt 12 vong cong mot vong di ve toi Postgres o Singapore.
     * Mot test dung ba nhan vat da ton hon bon giay truoc khi cham vao thu no
     * dinh kiem. Noi rong o day chu khong ha BCRYPT_ROUNDS: ha vong bcrypt
     * trong test la lam test chay tren mot cau hinh khac production.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
