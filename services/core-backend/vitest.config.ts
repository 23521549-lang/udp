import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
