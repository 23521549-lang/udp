import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  configHashOf,
  normalizeSnapshot,
  type SnapshotEntry,
  type SnapshotFlag,
} from "../src/snapshot.js";

/**
 * `config_hash` là hợp đồng giữa Service 2 và SDK trong ứng dụng của khách: cả
 * hai dựng snapshot rồi băm, và I15c đòi kết quả bằng nhau **từng bit**. Mọi
 * test dưới đây kiểm đúng một câu hỏi: cùng NỘI DUNG thì có cùng hash không, và
 * khác nội dung thì có khác hash không.
 */

const flag = (over: Partial<SnapshotFlag> = {}): SnapshotFlag => ({
  key: "dark-mode",
  flagType: "BOOLEAN",
  stickinessAttribute: "targetingKey",
  defaultVariantId: "v-off",
  variants: [
    { id: "v-on", key: "on", value: true },
    { id: "v-off", key: "off", value: false },
  ],
  isEnabled: true,
  envDefaultVariantId: null,
  rules: [
    {
      id: "r1",
      ruleType: "ALL",
      priority: 0,
      bucketSalt: "s1",
      condition: {},
      serve: {
        kind: "distribution",
        weights: [{ variantId: "v-on", weight: 20_000 }],
      },
    },
  ],
  ...over,
});

describe("chuẩn hoá không phụ thuộc thứ tự khoá", () => {
  it("hai object cùng nội dung khác thứ tự khoá cho cùng chuỗi", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("chuỗi NFD và NFC cho cùng chuỗi chuẩn hoá", () => {
    const name = "Nguyễn";
    expect(canonicalJson({ k: name.normalize("NFD") })).toBe(
      canonicalJson({ k: name.normalize("NFC") }),
    );
  });

  it("phân biệt null với trường vắng mặt", () => {
    // `JSON.stringify` trần nuốt `undefined` nên hai thứ này ra cùng chuỗi;
    // ở đây `undefined` bị từ chối thẳng, còn `null` giữ nguyên.
    expect(canonicalJson({ a: 1, b: null })).not.toBe(canonicalJson({ a: 1 }));
  });
});

describe("từ chối những giá trị không băm ổn định được", () => {
  it("ném khi gặp undefined", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(
      /không tuần tự hoá ổn định/,
    );
  });

  it("ném khi gặp số không nguyên", () => {
    expect(() => canonicalJson({ rate: 0.1 + 0.2 })).toThrow(/số không nguyên/);
  });

  it("ném khi gặp bigint", () => {
    expect(() => canonicalJson({ id: 1n })).toThrow(
      /không tuần tự hoá ổn định/,
    );
  });
});

describe("sắp xếp", () => {
  it("flag sắp theo key, rule sắp theo priority", () => {
    const unsorted = normalizeSnapshot([
      flag({ key: "zebra" }),
      flag({
        key: "alpha",
        rules: [
          {
            id: "b",
            ruleType: "ALL",
            priority: 5,
            bucketSalt: "s",
            condition: {},
            serve: {},
          },
          {
            id: "a",
            ruleType: "ALL",
            priority: 1,
            bucketSalt: "s",
            condition: {},
            serve: {},
          },
        ],
      }),
    ]);

    expect(unsorted.map((e) => e.key)).toEqual(["alpha", "zebra"]);
    const first = unsorted[0];
    expect(
      first !== undefined && "rules" in first
        ? first.rules.map((r) => r.id)
        : [],
    ).toEqual(["a", "b"]);
  });

  it("KHÔNG sắp weights — thứ tự đó mang ngữ nghĩa", () => {
    /**
     * Hai cấu hình dưới đây gán người dùng vào hai variant khác nhau, nên chúng
     * PHẢI có hash khác nhau. Nếu `normalizeSnapshot` sắp `weights`, hash sẽ
     * giống hệt và I15a mù đúng chỗ nguy hiểm nhất: replica áp delta sai thứ tự
     * vẫn báo là đã đồng bộ.
     */
    const forward = [
      flag({
        rules: [
          {
            id: "r",
            ruleType: "ALL",
            priority: 0,
            bucketSalt: "s",
            condition: {},
            serve: {
              kind: "distribution",
              weights: [
                { variantId: "a", weight: 10_000 },
                { variantId: "b", weight: 90_000 },
              ],
            },
          },
        ],
      }),
    ];
    const reversed = [
      flag({
        rules: [
          {
            id: "r",
            ruleType: "ALL",
            priority: 0,
            bucketSalt: "s",
            condition: {},
            serve: {
              kind: "distribution",
              weights: [
                { variantId: "b", weight: 90_000 },
                { variantId: "a", weight: 10_000 },
              ],
            },
          },
        ],
      }),
    ];

    expect(configHashOf(forward)).not.toBe(configHashOf(reversed));
  });
});

describe("hash phản ứng với mọi trường có nghĩa", () => {
  it("đổi default variant của environment thì hash phải đổi", () => {
    /**
     * Đây là kịch bản hỏng cụ thể nếu bỏ sót trường: người dùng đổi default của
     * `FlagEnvConfig`, `config_version` tăng nhưng hash không đổi. Replica áp
     * delta, tính lại hash, thấy KHỚP, và tự tin là đã đồng bộ trong khi đang
     * phục vụ default cũ. I15a sinh ra để bắt đúng chuyện này.
     */
    expect(configHashOf([flag()])).not.toBe(
      configHashOf([flag({ envDefaultVariantId: "v-on" })]),
    );
  });

  it("bia mộ của flag đã lưu trữ có mặt và ảnh hưởng tới hash", () => {
    const withTombstone = configHashOf([
      flag(),
      { key: "old-flag", archived: true },
    ]);
    expect(withTombstone).not.toBe(configHashOf([flag()]));
  });

  it("hash dài đúng 64 ký tự — vừa VARCHAR(64)", () => {
    expect(configHashOf([flag()])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cùng nội dung, khác thứ tự đầu vào, cho cùng hash", () => {
    const a = configHashOf([flag({ key: "b" }), flag({ key: "a" })]);
    const b = configHashOf([flag({ key: "a" }), flag({ key: "b" })]);
    expect(a).toBe(b);
  });
});
