import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * [v4.10] D-7 — đường rò thứ chín, mở MỘT LẦN.
     *
     * Bản cũ chỉ khai `tests/**` , nên một contract test đặt trong thư mục adapter
     * **không bao giờ chạy** và vitest không báo gì cả. Để nguyên thì câu "mọi adapter
     * đều qua bộ test hợp đồng" thành sai mà không ai thấy; còn sửa cấu hình mỗi lần
     * thêm adapter thì chính bất biến I28 (mọi adapter qua bộ hợp đồng) phụ thuộc vào
     * việc ai đó nhớ sửa một dòng config.
     *
     * Nên mở một lần cho CẢ quy ước thư mục: `src/modules/**` phủ mọi adapter tương lai
     * ở `modules/<domain>-adapter/<tool>/`. `design-lint` có một phép khẳng định đúng hai
     * mẫu này còn nguyên, để một lần "dọn dẹp" config không âm thầm đóng lại đường rò.
     */
    include: ["tests/**/*.test.ts", "src/modules/**/*.test.ts"],
    /**
     * [v4.11] Golden capture của hợp đồng dây: không làm gì trừ khi
     * `UDP_CAPTURE_WIRE=1` (xem `tests/helpers/wire-capture.ts`).
     */
    setupFiles: ["tests/helpers/wire-capture.ts"],
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
