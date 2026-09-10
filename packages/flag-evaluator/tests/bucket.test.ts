import { describe, expect, it } from "vitest";
import { TOTAL_BUCKETS } from "@udp/config/constants";
import type { FlagServe } from "@udp/shared-types";
import { bucketOf, pickVariant } from "../src/index.js";

/**
 * Ba bất biến về chia nhóm (I1, I2, I3 — §13.3).
 *
 * Chúng là hàm thuần, không chạm database, nên kiểm được bằng property-based
 * test trên hàng chục nghìn mẫu thay vì vài ca lẻ.
 */

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

const dist = (...weights: [string, number][]): FlagServe => ({
  kind: "distribution",
  weights: weights.map(([variantId, weight]) => ({ variantId, weight })),
});

/** Tập user nhận `variantId` với một cấu hình serve cho trước */
function audience(
  serve: FlagServe,
  variantId: string,
  count: number,
  salt = "salt-1",
): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < count; i++) {
    const stickyValue = `user-${String(i)}`;
    const pick = pickVariant(serve, {
      stickyValue,
      flagKey: "dark-mode",
      bucketSalt: salt,
    });
    if (pick.kind !== "no-sticky" && pick.variantId === variantId) {
      out.add(stickyValue);
    }
  }
  return out;
}

describe("I1 — nâng trọng số chỉ MỞ RỘNG nhóm của variant đang ramp", () => {
  /**
   * Phát biểu đã được thu hẹp trong §6.4, và test kiểm đúng bản đó.
   *
   * Bản mạnh hơn — "mọi variant đều giữ nguyên nhóm" — là SAI với ba variant trở
   * lên: tăng trọng số của variant đứng trước làm dịch khoảng của mọi variant
   * sau nó. Thiết kế ghi nhận điều đó ở §16 và nói rõ test phải kiểm mệnh đề
   * đúng, không kiểm mệnh đề mạnh hơn thứ hệ thống bảo đảm.
   */
  const N = 20_000;
  const pct = (n: number): number => (TOTAL_BUCKETS / 100) * n;

  it("canary hai nhánh: 10% ⊂ 20%", () => {
    const before = audience(dist([A, pct(90)], [B, pct(10)]), B, N);
    const after = audience(dist([A, pct(80)], [B, pct(20)]), B, N);

    expect(before.size).toBeGreaterThan(0);
    expect(after.size).toBeGreaterThan(before.size);
    for (const user of before) expect(after.has(user)).toBe(true);
  });

  it("ba variant: nhóm của variant ĐANG RAMP vẫn chỉ mở rộng", () => {
    const before = audience(
      dist([A, pct(80)], [B, pct(10)], [C, pct(10)]),
      B,
      N,
    );
    const after = audience(
      dist([A, pct(70)], [B, pct(20)], [C, pct(10)]),
      B,
      N,
    );

    expect(before.size).toBeGreaterThan(0);
    for (const user of before) expect(after.has(user)).toBe(true);
  });
});

describe("I2 — sticky theo user", () => {
  it("cùng user, cùng flag, cùng salt luôn cho cùng kết quả", () => {
    const serve = dist([A, 70_000], [B, 30_000]);
    const first = pickVariant(serve, {
      stickyValue: "user-42",
      flagKey: "dark-mode",
      bucketSalt: "salt-1",
    });

    for (let i = 0; i < 1000; i++) {
      expect(
        pickVariant(serve, {
          stickyValue: "user-42",
          flagKey: "dark-mode",
          bucketSalt: "salt-1",
        }),
      ).toEqual(first);
    }
  });

  /**
   * Phép thử NGƯỢC của lỗi đã sửa trong `hash.ts`.
   *
   * iOS gửi tên ở dạng NFD, Android và Windows gửi NFC. Không chuẩn hoá thì cùng
   * một người dùng nhận hai variant khác nhau tuỳ thiết bị — I2 vỡ mà không có
   * gì báo. Đo trên thư viện thô: NFC "Nguyễn" → 2229514937, NFD → 2660978039.
   */
  it("cùng tên ở NFC và NFD cho cùng bucket", () => {
    const name = "Nguyễn Văn A";
    const nfc = bucketOf({
      stickyValue: name.normalize("NFC"),
      flagKey: "f",
      bucketSalt: "s",
    });
    const nfd = bucketOf({
      stickyValue: name.normalize("NFD"),
      flagKey: "f",
      bucketSalt: "s",
    });

    expect(nfd).toBe(nfc);
  });

  /**
   * Phép thử NGƯỢC thứ hai: thư viện đọc khoá bằng `charCodeAt(i) & 0xff`, nên
   * nếu không mã hoá UTF-8 trước thì hai chuỗi khác nhau này va chạm. Đã đo:
   * 95/95 cặp ký tự `C` và `C + 0x100` cùng hash.
   */
  it("hai chuỗi khác nhau ở byte cao KHÔNG còn va chạm", () => {
    const a = bucketOf({
      stickyValue: "Nguyễn",
      flagKey: "f",
      bucketSalt: "s",
    });
    const b = bucketOf({
      stickyValue: "NguyÅn",
      flagKey: "f",
      bucketSalt: "s",
    });

    expect(a).not.toBe(b);
  });
});

describe("I3 — salt khác nhau chọn nhóm khác nhau", () => {
  it("hai rule 10% khác salt chồng lấn khoảng 1%, không phải 100%", () => {
    const N = 20_000;
    const serve = dist([A, 90_000], [B, 10_000]);
    const one = audience(serve, B, N, "salt-1");
    const two = audience(serve, B, N, "salt-2");

    const overlap = [...one].filter((u) => two.has(u)).length;
    const ratio = overlap / N;

    // Hai tập độc lập, mỗi tập ~10% ⇒ kỳ vọng chồng lấn ~1%. Biên rộng vì đây
    // là phép đo thống kê, nhưng đủ hẹp để phân biệt với 10% (cùng salt).
    expect(ratio).toBeGreaterThan(0.005);
    expect(ratio).toBeLessThan(0.02);
  });

  it("CÙNG salt thì chồng lấn hoàn toàn — phép thử dương của test trên", () => {
    const N = 5_000;
    const serve = dist([A, 90_000], [B, 10_000]);
    const one = audience(serve, B, N, "salt-1");
    const two = audience(serve, B, N, "salt-1");

    expect(one.size).toBeGreaterThan(0);
    expect([...one].filter((u) => two.has(u)).length).toBe(one.size);
  });
});

describe("người dùng ẩn danh", () => {
  it("không có stickyValue thì trả no-sticky, KHÔNG bốc ngẫu nhiên", () => {
    const serve = dist([A, 50_000], [B, 50_000]);

    for (const stickyValue of [undefined, ""]) {
      expect(
        pickVariant(serve, { stickyValue, flagKey: "f", bucketSalt: "s" }),
      ).toEqual({ kind: "no-sticky" });
    }
  });

  it("serve kiểu variant vẫn áp dụng cho người ẩn danh", () => {
    expect(
      pickVariant(
        { kind: "variant", variantId: A },
        { stickyValue: undefined, flagKey: "f", bucketSalt: "s" },
      ),
    ).toEqual({ kind: "variant", variantId: A });
  });
});
