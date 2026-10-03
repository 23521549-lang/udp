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
    /**
     * [v4.11] `.tsx` cùng khối: bản trước chỉ khai đuôi `.ts`, tức lint mù hoàn toàn với
     * mã React của Portal — cùng lỗi `".tsx".endsWith(".ts") === false` đã sửa ở cổng
     * ranh giới package (b1a861d), lần này ở chính ESLint.
     */
    files: ["**/*.ts", "**/*.tsx"],
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
       * Hai luật của thư mục adapter nằm ở KHỐI RIÊNG phía dưới, không ở đây.
       *
       * Chỗ dành sẵn cũ đã được thay bằng khối thật khi adapter đầu tiên xuất
       * hiện (`modules/monitoring-adapter/prometheus-grafana/`) — đúng theo R6:
       * một luật viết trước người dùng là một luật không ai biết nó có chạy hay
       * không.
       */
    },
  },

  {
    /**
     * [v4.10] Hai luật CHỈ áp trong thư mục adapter (§4.6, §12 T11, §4.3).
     *
     * Glob trỏ tới cây THẬT của §1.6 — `modules/<domain>-adapter/<tool>/`. Chỗ
     * dành sẵn cũ ghi `adapters/` số nhiều, không khớp tệp nào, nên nó sẽ là
     * một khối lint xanh vĩnh viễn: đúng loại bảo đảm tệ nhất. `design-lint` có
     * một ô khẳng định glob này khớp **ít nhất một tệp thật**, để lỗi đó không
     * quay lại.
     *
     * **Luật 1 — cấm `fetch` toàn cục.** Mọi lời gọi ra ngoài của adapter phải
     * đi qua `ctx.fetch`, tức qua egress guard chống SSRF. Một `fetch` trực
     * tiếp vòng qua guard, và nó chạy được trên máy người viết adapter nên
     * không ai thấy gì sai cho tới khi có người trỏ nó vào metadata endpoint
     * của cloud.
     *
     * **Luật 2 — cấm adapter chuyển secret sang `string`.** Luật này KHÔNG
     * hiện thực bằng lint, và nói rõ vì sao thay vì để người đọc đi tìm: ESLint
     * không biết kiểu của một biểu thức trong `no-restricted-syntax`, nên mọi
     * luật cú pháp cho nó đều là một xấp xỉ — cấm `String(x)` và `` `${x}` ``
     * trong cả thư mục adapter thì chặn luôn mọi lần nối chuỗi hợp lệ, còn cấm
     * hẹp hơn thì lách được bằng một biến trung gian. Bảo đảm THẬT nằm ở tầng
     * kiểu và tầng chạy: `SecretBuffer.toString()` khai trả `never` và NÉM lúc
     * chạy (`secret-buffer.test.ts`), `toJSON` cùng `inspect` trả `[REDACTED]`,
     * và phép quét sentinel của P12 đi qua chín kênh ra ngoài. Một luật lint
     * yếu hơn ở đây sẽ thêm nhiễu mà không thêm bảo đảm.
     */
    files: ["**/modules/*-adapter/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "Adapter phải gọi ra ngoài qua `ctx.fetch` (egress guard, §12 T11), " +
            "không dùng fetch toàn cục.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='globalThis'][property.name='fetch']",
          message:
            "Adapter phải gọi ra ngoài qua `ctx.fetch` (egress guard, §12 T11).",
        },
      ],
    },
  },

  {
    // Test được phép dùng `!` sau một khẳng định: ở đó dấu `!` không phải lời
    // hứa về thứ tự middleware mà là hệ quả của một `expect` ngay phía trên.
    files: ["**/tests/**/*.ts", "**/tests/**/*.tsx"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
