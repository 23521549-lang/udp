import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [v4.10] D-7 — đường rò thứ chín: contract test trong thư mục adapter KHÔNG BAO GIỜ chạy.
 *
 * `services/core-backend/vitest.config.ts` từng khai `include: ["tests/**"]`, nên một
 * contract test đặt cạnh adapter không được vitest nhặt, **và vitest không báo lỗi gì**.
 * Hậu quả không phải một test đỏ mà là một câu tuyên bố thành sai: bất biến I28 nói mọi
 * adapter đều qua bộ test hợp đồng, và với cấu hình cũ thì câu đó đúng chỉ khi ai đó nhớ
 * đặt test vào đúng `tests/`.
 *
 * Phép kiểm này đọc chính tệp cấu hình. Nó không thay được một phép "glob khớp ≥ 1 tệp
 * thật" — phép đó cần có adapter thật nên nó thuộc P19 — nhưng nó chặn được đường lùi:
 * một lần "dọn dẹp" cấu hình bỏ bớt mẫu sẽ làm phép này đỏ, kèm lý do ngay tại chỗ.
 */

const CONFIG = resolve(
  import.meta.dirname,
  "../../../services/core-backend/vitest.config.ts",
);

/** Hai mẫu phải CÒN trong `include` của Service 1 */
const REQUIRED_PATTERNS = ["tests/**/*.test.ts", "src/modules/**/*.test.ts"];

describe("vitest include của Service 1 phủ cả thư mục adapter (D-7)", () => {
  it("tệp cấu hình đọc được", () => {
    expect(readFileSync(CONFIG, "utf8").length).toBeGreaterThan(0);
  });

  it("cả hai mẫu còn nguyên trong include", () => {
    const source = readFileSync(CONFIG, "utf8");
    const missing = REQUIRED_PATTERNS.filter((p) => !source.includes(p));
    expect(
      missing,
      "mẫu bị bỏ khỏi include ⇒ test trong thư mục đó không bao giờ chạy",
    ).toEqual([]);
  });

  /**
   * Và `include` KHÔNG được thu về một mẫu duy nhất.
   *
   * Một phép chỉ kiểm "có chứa chuỗi X" vẫn xanh nếu ai đó để lại mẫu cũ trong một chú
   * thích rồi thay `include` bằng một mẫu khác. Nên kiểm cả hình: dòng `include:` phải
   * chứa **hai** mẫu.
   */
  it("dòng include khai đúng hai mẫu, không phải một", () => {
    const source = readFileSync(CONFIG, "utf8");
    const line = /include:\s*\[([^\]]*)\]/.exec(source);
    expect(line, "không tìm thấy khai báo include").not.toBeNull();
    const patterns = (line?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(patterns).toHaveLength(2);
  });
});
