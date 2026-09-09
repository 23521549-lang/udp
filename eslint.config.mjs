import tseslint from "typescript-eslint";

/**
 * Lint cho toàn bộ workspace.
 *
 * Vì sao chỉ bật một nhúm luật thay vì lấy nguyên preset `recommended`: đã đo
 * trên 73 file, `recommendedTypeChecked + stylisticTypeChecked` cho 163 lỗi,
 * trong đó 64 nằm gọn trong một file test chỉ vì `res.body` của supertest có
 * kiểu `any`, và `dot-notation` thì đạp thẳng vào quy ước `process.env["X"]`
 * mà repo dùng có chủ đích (`noUncheckedIndexedAccess` khiến lối truy cập đó
 * là lối AN TOÀN, không phải lối lười). Một linter mà phần lớn cảnh báo là
 * nhiễu sẽ bị tắt trong vòng một tuần.
 *
 * Năm luật dưới đây được chọn vì mỗi luật bắt một lớp lỗi CÓ THẬT trong mã
 * bất đồng bộ và mã có ràng buộc kiểu chặt, không phải vì phong cách.
 *
 * Ghi lại một tiền đề SAI của tôi khi lên plan, để người sau không lặp lại:
 * tôi tưởng `no-floating-promises` sẽ bắt mẫu `void (async () => {…})()` ở ba
 * middleware. Đo thật: nó bắt **0 chỗ**, vì `ignoreVoid: true` là mặc định nên
 * chính toán tử `void` đã miễn trừ. Luật thật sự tìm ra thiệt hại là
 * `no-misused-promises`, với 19/20 lỗi bắt nguồn từ đúng một dòng khai kiểu.
 */

export default tseslint.config(
  {
    // Mã sinh tự động: 33 file, 2.8 MB, nằm trong `src/**` nên không tách ra
    // khỏi tsconfig được (và không được tách — `src/index.ts` import nó). Bỏ
    // khỏi ESLint chứ không bỏ khỏi TypeScript program.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "packages/db/src/generated/**",
    ],
  },

  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        // `projectService` thay cho danh sách `project` tường minh: hai package
        // chỉ `include` thư mục `src/**`, nên mọi file ngoài đó (test, script,
        // vitest.config) sẽ rơi ra ngoài program nếu liệt kê tay.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /**
       * Bắt được 20 chỗ, và 19 trong số đó là cùng một nguyên nhân: một hàm
       * nhận `async` nhưng khai kiểu trả `void`. Runtime vẫn đúng nhờ có
       * `.catch`, nhưng kiểu nói dối — và kiểu nói dối là thứ khiến người đọc
       * sau tin rằng lỗi đã được xử lý ở chỗ nó không hề được xử lý.
       */
      "@typescript-eslint/no-misused-promises": "error",

      /**
       * Với `exactOptionalPropertyTypes` và `noUncheckedIndexedAccess`, luật
       * này vừa hữu ích vừa nguy hiểm: 6 trong 11 chỗ nó chỉ ra là LƯỚI AN
       * TOÀN thật (`client?.end()` khi `beforeAll` có thể đã ném). Cách sửa
       * đúng ở đó là khai `Client | undefined`, KHÔNG phải xoá `?.`. Vì vậy
       * tuyệt đối không chạy `--fix` mù cho luật này.
       */
      "@typescript-eslint/no-unnecessary-condition": "error",

      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",

      /**
       * `req.user!` xuất hiện 4 chỗ. Dấu `!` ở đúng chỗ phân quyền là nơi tệ
       * nhất để tắt kiểm tra kiểu: nó nói "tin tôi đi, middleware đã chạy rồi"
       * — một lời hứa không ai kiểm được khi thứ tự middleware đổi.
       */
      "@typescript-eslint/no-non-null-assertion": "error",

      /**
       * CHỖ DÀNH SẴN cho ba luật mà thiết kế gọi đích danh, chưa bật vì chưa
       * có thư mục adapter nào để áp (R6 — không viết luật trước người dùng):
       *
       *   §4.6 và §12 T11 — cấm `fetch` trực tiếp trong thư mục adapter, mọi
       *     lời gọi ra ngoài phải đi qua egress guard chống SSRF.
       *   §4.3 — cấm adapter chuyển secret sang `string`.
       *
       * Cả ba hiện thực bằng `no-restricted-imports` / `no-restricted-syntax`
       * trong một khối `files: ["**\/adapters/**"]` riêng. Bất biến I35
       * (dependency-cruiser) là công cụ khác, chạy ở CI.
       */
    },
  },

  {
    // Test được phép dùng `!` sau một khẳng định: ở đó dấu `!` không phải lời
    // hứa về thứ tự middleware mà là hệ quả của một `expect` ngay phía trên.
    files: ["**/tests/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
