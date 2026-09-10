import { describe, expect, it } from "vitest";
import {
  canonicalizeServe,
  flagServeDbSchema,
  type FlagServe,
} from "../src/evaluation.js";

/**
 * `canonicalizeServe` là chỗ DUY NHẤT ép thứ tự `weights` (§6.4).
 *
 * Evaluator "không sort lúc chạy" và cộng dồn theo thứ tự mảng, nên thứ tự lưu
 * xuống quyết định ai thấy variant nào. Đã đo: giữ nguyên `bucketSalt` và phần
 * trăm, chỉ đảo thứ tự `weights`, làm 100% người đang thấy `on` đổi nhóm. Mọi
 * đường ghi `serve` đều phải đi qua hàm này, nên nó xứng đáng có test riêng thay
 * vì chỉ được kiểm gián tiếp qua HTTP.
 */

// Hai UUID mà thứ tự từ điển NGƯỢC với thứ tự "target, other" của §7.3
const LOW = "00000000-0000-4000-8000-00000000000a";
const HIGH = "00000000-0000-4000-8000-00000000000b";

const dist = (...weights: [string, number][]): FlagServe => ({
  kind: "distribution",
  weights: weights.map(([variantId, weight]) => ({ variantId, weight })),
});

describe("canonicalizeServe — thứ tự weights được ép ở tầng GHI", () => {
  it("sắp theo variantId, kể cả khi bên gọi gửi đúng hình dạng mẫu [target, other] của §7.3", () => {
    /**
     * Body ramp mẫu của Service 3 đặt variant đích lên trước. Khi UUID của nó
     * lớn hơn, không sắp ở đây nghĩa là lưu sai thứ tự — và rule đó đảo nhóm
     * người dùng ở lần ramp kế tiếp.
     */
    expect(canonicalizeServe(dist([HIGH, 30_000], [LOW, 70_000]))).toEqual(
      dist([LOW, 70_000], [HIGH, 30_000]),
    );
  });

  it("hai thứ tự gửi lên cho CÙNG một kết quả lưu", () => {
    /** Đây là toàn bộ bảo đảm của I1 ở tầng ghi: thứ tự không phụ thuộc bên gọi */
    expect(canonicalizeServe(dist([HIGH, 30_000], [LOW, 70_000]))).toEqual(
      canonicalizeServe(dist([LOW, 70_000], [HIGH, 30_000])),
    );
  });

  it("KHÔNG sửa mảng của bên gọi", () => {
    const input = dist([HIGH, 30_000], [LOW, 70_000]);
    canonicalizeServe(input);

    expect(input.kind === "distribution" && input.weights[0]?.variantId).toBe(
      HIGH,
    );
  });

  it("idempotent — sắp một mảng đã chuẩn thì không đổi gì", () => {
    const once = canonicalizeServe(dist([HIGH, 30_000], [LOW, 70_000]));
    expect(canonicalizeServe(once)).toEqual(once);
  });

  it("serve kiểu variant đi qua nguyên vẹn", () => {
    const serve: FlagServe = { kind: "variant", variantId: LOW };
    expect(canonicalizeServe(serve)).toEqual(serve);
  });

  it("kết quả vẫn qua flagServeDbSchema — sắp không làm hỏng tổng hay tính duy nhất", () => {
    const serve = canonicalizeServe(
      dist(
        [HIGH, 20_000],
        [LOW, 50_000],
        ["00000000-0000-4000-8000-000000000001", 30_000],
      ),
    );
    expect(flagServeDbSchema.safeParse(serve).success).toBe(true);
  });
});
