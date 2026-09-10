import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  configHashOf,
  normalizeSnapshot,
  type Snapshot,
  type SnapshotFlag,
  type SnapshotRule,
} from "../src/snapshot.js";

/**
 * `config_hash` là hợp đồng giữa Service 2 và SDK trong ứng dụng của khách: cả
 * hai dựng snapshot rồi băm, và I15c đòi kết quả bằng nhau **từng bit**. Mọi
 * test dưới đây kiểm đúng một câu hỏi: cùng NỘI DUNG thì có cùng hash không, và
 * khác nội dung thì có khác hash không.
 *
 * Fixture cố ý dùng ĐÚNG hình dạng §9 gửi trên dây — `variantKey`, `variants` là
 * bảng tra, không có id nội bộ nào. Nếu fixture ở đây còn dựng được một hình
 * dạng mà SDK không bao giờ nhận được, thì test có xanh cũng không chứng minh
 * được điều I15c cần.
 */

const rule = (over: Partial<SnapshotRule> = {}): SnapshotRule => ({
  id: "r1",
  type: "ALL",
  priority: 0,
  bucketSalt: "s1",
  condition: {},
  serve: {
    kind: "distribution",
    weights: [{ variantKey: "on", weight: 100_000 }],
  },
  ...over,
});

const flag = (over: Partial<SnapshotFlag> = {}): SnapshotFlag => ({
  key: "dark-mode",
  type: "BOOLEAN",
  isEnabled: true,
  stickinessAttribute: "targetingKey",
  variants: { on: true, off: false },
  defaultVariantKey: "off",
  rules: [rule()],
  ...over,
});

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  flags: [flag()],
  segments: [],
  trackedFlags: [],
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
    const normalized = normalizeSnapshot(
      snapshot({
        flags: [
          flag({ key: "zebra" }),
          flag({
            key: "alpha",
            rules: [
              rule({ id: "b", priority: 5 }),
              rule({ id: "a", priority: 1 }),
            ],
          }),
        ],
      }),
    );

    expect(normalized.flags.map((e) => e.key)).toEqual(["alpha", "zebra"]);
    const first = normalized.flags[0];
    expect(
      first !== undefined && "rules" in first
        ? first.rules.map((r) => r.id)
        : [],
    ).toEqual(["a", "b"]);
  });

  it("segment sắp theo id, trackedFlags sắp theo chuỗi", () => {
    const normalized = normalizeSnapshot(
      snapshot({
        segments: [
          { id: "s-z", conditions: [] },
          { id: "s-a", conditions: [] },
        ],
        trackedFlags: ["zebra", "alpha"],
      }),
    );

    expect(normalized.segments.map((s) => s.id)).toEqual(["s-a", "s-z"]);
    expect(normalized.trackedFlags).toEqual(["alpha", "zebra"]);
  });

  it("hai rule HOÀ priority vẫn cho cùng một hash", () => {
    /**
     * `priority` KHÔNG có ràng buộc UNIQUE — `schema.prisma` chỉ khai
     * `@@index([flagEnvConfigId, priority])`. Nên hai rule hoà nhau là hợp lệ, và
     * lúc đó thứ tự mảng đến từ Postgres, vốn không được bảo đảm và đổi sau mỗi
     * lần UPDATE.
     *
     * `Array.sort` của JavaScript ỔN ĐỊNH, nên sắp chỉ theo `priority` sẽ GIỮ
     * NGUYÊN thứ tự đầu vào khi hoà — tức là giữ nguyên một thứ tự tuỳ ý. Service 2
     * và SDK khi đó băm cùng một nội dung theo hai thứ tự khác nhau, `config_hash`
     * lệch VĨNH VIỄN, và triệu chứng là ngắt mạch tầng 2 mỗi 5 phút mãi mãi —
     * trong khi không có bug thật nào ở đâu cả.
     */
    const a = snapshot({
      flags: [
        flag({
          rules: [
            rule({ id: "r-a", priority: 5 }),
            rule({ id: "r-b", priority: 5 }),
          ],
        }),
      ],
    });
    const b = snapshot({
      flags: [
        flag({
          rules: [
            rule({ id: "r-b", priority: 5 }),
            rule({ id: "r-a", priority: 5 }),
          ],
        }),
      ],
    });

    expect(configHashOf(a)).toBe(configHashOf(b));
  });

  it("KHÔNG sắp weights — thứ tự đó mang ngữ nghĩa", () => {
    /**
     * Hai cấu hình dưới đây gán người dùng vào hai variant khác nhau, nên chúng
     * PHẢI có hash khác nhau. Nếu `normalizeSnapshot` sắp `weights`, hash sẽ
     * giống hệt và I15a mù đúng chỗ nguy hiểm nhất: replica áp delta sai thứ tự
     * vẫn báo là đã đồng bộ.
     *
     * Đây cũng là lý do §9 phải khai `weights` là MẢNG. Bản trước khai
     * `Record<string, number>`; một `Record` không mang được thứ tự này, và
     * `canonicalJson` còn sắp khoá object, nên hai cấu hình dưới đây sẽ ra CÙNG
     * một hash — test này sẽ đỏ, đúng như nó phải thế.
     */
    const forward = snapshot({
      flags: [
        flag({
          rules: [
            rule({
              serve: {
                kind: "distribution",
                weights: [
                  { variantKey: "on", weight: 10_000 },
                  { variantKey: "off", weight: 90_000 },
                ],
              },
            }),
          ],
        }),
      ],
    });
    const reversed = snapshot({
      flags: [
        flag({
          rules: [
            rule({
              serve: {
                kind: "distribution",
                weights: [
                  { variantKey: "off", weight: 90_000 },
                  { variantKey: "on", weight: 10_000 },
                ],
              },
            }),
          ],
        }),
      ],
    });

    expect(configHashOf(forward)).not.toBe(configHashOf(reversed));
  });
});

describe("hash phản ứng với mọi trường có nghĩa", () => {
  it("đổi default variant thì hash phải đổi", () => {
    /**
     * Kịch bản hỏng cụ thể nếu bỏ sót trường: người dùng đổi default của
     * `FlagEnvConfig`, `config_version` tăng nhưng hash không đổi. Replica áp
     * delta, tính lại hash, thấy KHỚP, và tự tin là đã đồng bộ trong khi đang
     * phục vụ default cũ. I15a sinh ra để bắt đúng chuyện này.
     *
     * Trên dây chỉ có MỘT trường `defaultVariantKey`: phép chọn giữa override
     * của environment và default của flag (§6.5 — `envConfig.defaultVariantId ??
     * flag.defaultVariantId`) đã xảy ra ở tầng chiếu. Nên test này canh đúng thứ
     * SDK thấy, thay vì canh hai trường mà SDK không bao giờ nhận.
     */
    expect(configHashOf(snapshot())).not.toBe(
      configHashOf(snapshot({ flags: [flag({ defaultVariantKey: "on" })] })),
    );
  });

  it("đổi segment thì hash phải đổi", () => {
    /**
     * `segment.updated` là một `change_type` hợp lệ và một lần sửa segment đổi
     * kết quả đánh giá của mọi rule `SEGMENT`. Bản trước KHÔNG có `segments`
     * trong snapshot, nên checksum nội dung mù đúng loại thay đổi đó — mù có
     * chọn lọc còn tệ hơn không có checksum, vì nó tạo niềm tin sai.
     */
    expect(configHashOf(snapshot({ segments: [] }))).not.toBe(
      configHashOf(
        snapshot({ segments: [{ id: "s-1", conditions: [{ k: "v" }] }] }),
      ),
    );
  });

  it("đổi trackedFlags thì hash phải đổi", () => {
    /**
     * §6.6: thêm flag vào tập tracked tăng `config_version` trong CÙNG transaction
     * như mọi thay đổi khác, để nó thừa hưởng bảo đảm của ADR-05 thay vì là một
     * kênh thứ hai phải tự kiểm. Thừa hưởng nghĩa là phải nằm trong checksum.
     */
    expect(configHashOf(snapshot({ trackedFlags: [] }))).not.toBe(
      configHashOf(snapshot({ trackedFlags: ["dark-mode"] })),
    );
  });

  it("bia mộ của flag đã lưu trữ có mặt và ảnh hưởng tới hash", () => {
    const withTombstone = configHashOf(
      snapshot({ flags: [flag(), { key: "old-flag", archived: true }] }),
    );
    expect(withTombstone).not.toBe(configHashOf(snapshot()));
  });

  it("hash dài đúng 64 ký tự — vừa VARCHAR(64)", () => {
    expect(configHashOf(snapshot())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cùng nội dung, khác thứ tự đầu vào, cho cùng hash", () => {
    const a = configHashOf(
      snapshot({ flags: [flag({ key: "b" }), flag({ key: "a" })] }),
    );
    const b = configHashOf(
      snapshot({ flags: [flag({ key: "a" }), flag({ key: "b" })] }),
    );
    expect(a).toBe(b);
  });
});
