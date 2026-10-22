import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /**
     * [v4.10] Tran moi phep, dat SAU phep do (QD-24).
     *
     * Luoi khoi phuc tang 1 co 91 o; o cham nhat do duoc la 1.14 s (ba luot chay day du:
     * 50.6 s, 60.2 s, va 57.9 s cho ca goi). 5 s la 4.4 lan o cham nhat - du rong de
     * khong rung, du chat de bat mot hoi quy that (them mot lan cho dong ho vao moi o).
     *
     * Con so nay TRUNG mac dinh hien tai cua vitest, va do chinh la ly do phai viet ra:
     * mot tran dung nho mac dinh la mot tran se doi am tham khi cong cu len phien ban.
     *
     * Tran muc TEP la 120 s cho tang 1 (~2 lan luot cham nhat). Vuot tran thi tach
     * project vitest rieng cho luoi, KHONG bo o - bo o la cach duy nhat chac chan dat
     * moi tran, va cung la cach duy nhat chac chan mat bao dam.
     */
    testTimeout: 5_000,
  },
});
