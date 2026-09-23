import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyChange,
  applyDelta,
  configHashOf,
  hashVerdict,
  normalizeSnapshot,
  parseSdkConfig,
  parseSdkDelta,
  type SdkStreamChange,
  type Snapshot,
  type SnapshotFlag,
  type SnapshotSegment,
} from "../src/index.js";

/**
 * Áp delta dùng chung S2 ↔ provider [v4.7] — I15a (nội dung sai ⇒ RESYNC), I18
 * (hổng con trỏ ⇒ RESYNC), bỏ qua event cũ, và parse vỏ dây không bao giờ ném.
 */

const flag = (key: string, isEnabled = true): SnapshotFlag => ({
  key,
  type: "BOOLEAN",
  isEnabled,
  stickinessAttribute: "targetingKey",
  variants: { on: true, off: false },
  defaultVariantKey: "off",
  rules: [],
});

const segment = (id: string, userIds: string[] = []): SnapshotSegment => ({
  id,
  all: [],
  userIds,
});

const base: Snapshot = { flags: [flag("a")], segments: [], trackedFlags: [] };

describe("applyChange", () => {
  it("flag thay entry cùng key; flagAbsent xoá nếu có (idempotent); trackedFlags thay cả tập", () => {
    const withB = applyChange(base, {
      configVersion: 2,
      kind: "flag",
      flag: flag("b"),
    });
    expect(withB.flags.map((f) => f.key)).toEqual(["a", "b"]);
    const noB = applyChange(withB, {
      configVersion: 3,
      kind: "flagAbsent",
      key: "b",
    });
    expect(
      applyChange(noB, { configVersion: 4, kind: "flagAbsent", key: "b" }),
    ).toEqual(noB);
    expect(
      applyChange(base, {
        configVersion: 5,
        kind: "trackedFlags",
        trackedFlags: ["a"],
      }).trackedFlags,
    ).toEqual(["a"]);
  });

  it("[v4.9] segment thay entry cùng id; segmentAbsent xoá nếu có (idempotent)", () => {
    const withS = applyChange(base, {
      configVersion: 2,
      kind: "segment",
      segment: segment("s1", ["u1"]),
    });
    expect(withS.segments).toEqual([segment("s1", ["u1"])]);

    const edited = applyChange(withS, {
      configVersion: 3,
      kind: "segment",
      segment: segment("s1", ["u1", "u2"]),
    });
    expect(edited.segments).toEqual([segment("s1", ["u1", "u2"])]);

    const gone = applyChange(edited, {
      configVersion: 4,
      kind: "segmentAbsent",
      id: "s1",
    });
    expect(gone.segments).toEqual([]);
    expect(
      applyChange(gone, { configVersion: 5, kind: "segmentAbsent", id: "s1" }),
    ).toEqual(gone);

    // Không phần tử nào của segment được chạm tới flag hay trackedFlags
    expect(gone.flags).toEqual(base.flags);
    expect(base.segments, "snapshot đầu vào bị sửa tại chỗ").toEqual([]);
  });
});

describe("hashVerdict", () => {
  it("chuỗi rỗng = chưa có mốc; khớp; lệch", () => {
    expect(hashVerdict(base, "")).toBe("no-baseline");
    expect(hashVerdict(base, configHashOf(base))).toBe("ok");
    expect(hashVerdict(base, "a".repeat(64))).toBe("mismatch");
  });
});

describe("applyDelta", () => {
  const next = applyChange(base, {
    configVersion: 8,
    kind: "flag",
    flag: flag("a", false),
  });
  const delta = (over: object = {}) => ({
    fromVersion: 7,
    toVersion: 8,
    configHash: configHashOf(next),
    changes: [
      { configVersion: 8, kind: "flag" as const, flag: flag("a", false) },
    ],
    ...over,
  });

  it("đúng con trỏ, đúng nội dung ⇒ applied ở toVersion", () => {
    const out = applyDelta({ snapshot: base, configVersion: 7 }, delta());
    expect(out.kind).toBe("applied");
    if (out.kind === "applied") {
      expect(out.configVersion).toBe(8);
      expect(normalizeSnapshot(out.snapshot)).toEqual(normalizeSnapshot(next));
    }
  });

  it("toVersion ≤ con trỏ ⇒ ignored; fromVersion ≠ con trỏ ⇒ resync gap (I18)", () => {
    expect(applyDelta({ snapshot: base, configVersion: 8 }, delta()).kind).toBe(
      "ignored",
    );
    expect(applyDelta({ snapshot: base, configVersion: 6 }, delta())).toEqual({
      kind: "resync",
      reason: "gap",
    });
  });

  it("gộp nhiều dòng (toVersion > from + 1) vẫn áp — chỉ so fromVersion", () => {
    const out = applyDelta(
      { snapshot: base, configVersion: 7 },
      delta({ toVersion: 10 }),
    );
    expect(out).toMatchObject({ kind: "applied", configVersion: 10 });
  });

  it("đúng SỐ sai NỘI DUNG ⇒ resync hash-mismatch (I15a); mốc rỗng ⇒ chấp nhận", () => {
    expect(
      applyDelta(
        { snapshot: base, configVersion: 7 },
        delta({ configHash: "f".repeat(64) }),
      ),
    ).toEqual({ kind: "resync", reason: "hash-mismatch" });
    expect(
      applyDelta(
        { snapshot: base, configVersion: 7 },
        delta({ configHash: "" }),
      ).kind,
    ).toBe("applied");
  });
});

describe("parseSdkConfig / parseSdkDelta — dữ liệu dây sai hình ⇒ undefined, không ném", () => {
  it("vỏ đúng hình qua; sai hình trả undefined", () => {
    const body = {
      configVersion: 3,
      configHash: "",
      environment: "dev",
      trackedFlags: [],
      flags: [flag("a"), { key: "x", archived: true }],
      segments: [{ id: "s", all: [], userIds: ["u"] }],
    };
    expect(parseSdkConfig(body)).toEqual(body);
    for (const bad of [
      null,
      5,
      "x",
      { ...body, flags: [{}] },
      { ...body, configVersion: -1 },
    ]) {
      expect(parseSdkConfig(bad)).toBeUndefined();
    }
  });

  it("kind lạ làm cả event sai hình (§6.8: RESYNC, không đoán)", () => {
    const ok = {
      fromVersion: 1,
      toVersion: 2,
      configHash: "",
      changes: [{ configVersion: 2, kind: "flagAbsent", key: "a" }],
    };
    expect(parseSdkDelta(ok)).toEqual(ok);
    expect(
      parseSdkDelta({
        ...ok,
        changes: [{ configVersion: 2, kind: "flag.renamed", key: "a" }],
      }),
    ).toBeUndefined();
  });

  it("[v4.9] segment và segmentAbsent qua; segment thiếu trường vẫn sai hình", () => {
    const ok = {
      fromVersion: 1,
      toVersion: 3,
      configHash: "",
      changes: [
        { configVersion: 2, kind: "segment", segment: segment("s", ["u"]) },
        { configVersion: 3, kind: "segmentAbsent", id: "s2" },
      ],
    };
    expect(parseSdkDelta(ok)).toEqual(ok);

    for (const bad of [
      // `id` không phải chuỗi rỗng, `all`/`userIds` phải là mảng, userIds toàn chuỗi
      { configVersion: 2, kind: "segment", segment: { id: "s" } },
      {
        configVersion: 2,
        kind: "segment",
        segment: { ...segment("s"), userIds: [1] },
      },
      { configVersion: 2, kind: "segmentAbsent", id: "" },
    ]) {
      expect(parseSdkDelta({ ...ok, changes: [bad] })).toBeUndefined();
    }
  });
});

/**
 * I15c — "áp N delta cho ra đúng snapshot tại cùng version", [v4.9] có cả segment.
 *
 * Hai điều được canh, và cái thứ hai mới là phần khó: (1) chia cùng một dãy thay
 * đổi thành nhiều event cho ra CÙNG hash với gộp làm một event; (2) kết quả khớp
 * một oracle dựng ĐỘC LẬP với `applyChange` (ghi-sau-thắng bằng `Map`). Không có
 * oracle độc lập thì phép so chỉ khẳng định `applyChange` bằng chính nó, và một
 * lỗi thứ tự — ví dụ `segment` chèn đầu mảng ở nơi này, cuối mảng ở nơi kia —
 * vẫn xanh trong khi S2 và provider ra hai hash khác nhau.
 */
describe("I15c property — áp theo lô bằng áp một lần, và khớp oracle độc lập", () => {
  const expectedOf = (
    from: Snapshot,
    ops: readonly SdkStreamChange[],
  ): Snapshot => {
    const flags = new Map(from.flags.map((f) => [f.key, f] as const));
    const segments = new Map(from.segments.map((s) => [s.id, s] as const));
    let trackedFlags = [...from.trackedFlags];
    for (const op of ops) {
      if (op.kind === "flag") flags.set(op.flag.key, op.flag);
      else if (op.kind === "flagAbsent") flags.delete(op.key);
      else if (op.kind === "segment") segments.set(op.segment.id, op.segment);
      else if (op.kind === "segmentAbsent") segments.delete(op.id);
      else trackedFlags = [...op.trackedFlags];
    }
    return {
      flags: [...flags.values()],
      segments: [...segments.values()],
      trackedFlags,
    };
  };

  const segmentArb = fc.record({
    id: fc.constantFrom("s1", "s2", "s3"),
    all: fc.constant([] as unknown[]),
    userIds: fc.array(fc.constantFrom("u1", "u2", "u3"), { maxLength: 3 }),
  });

  const opArb: fc.Arbitrary<SdkStreamChange> = fc.oneof(
    fc
      .record({ key: fc.constantFrom("a", "b", "c"), on: fc.boolean() })
      .map(({ key, on }) => ({
        configVersion: 0,
        kind: "flag" as const,
        flag: flag(key, on),
      })),
    fc.constantFrom("a", "b", "c").map((key) => ({
      configVersion: 0,
      kind: "flagAbsent" as const,
      key,
    })),
    segmentArb.map((s) => ({
      configVersion: 0,
      kind: "segment" as const,
      segment: s,
    })),
    fc.constantFrom("s1", "s2", "s3").map((id) => ({
      configVersion: 0,
      kind: "segmentAbsent" as const,
      id,
    })),
    fc
      .uniqueArray(fc.constantFrom("a", "b", "c"), { maxLength: 3 })
      .map((keys) => ({
        configVersion: 0,
        kind: "trackedFlags" as const,
        trackedFlags: [...keys].sort(),
      })),
  );

  it("mọi dãy thay đổi, mọi cách chia lô", () => {
    fc.assert(
      fc.property(
        fc.array(segmentArb, { maxLength: 3 }),
        fc.array(opArb, { minLength: 1, maxLength: 12 }),
        fc.array(fc.integer({ min: 1, max: 4 }), {
          minLength: 1,
          maxLength: 6,
        }),
        (startSegments, ops, sizes) => {
          const start: Snapshot = {
            flags: [flag("a"), flag("b", false)],
            segments: [
              ...new Map(startSegments.map((s) => [s.id, s])).values(),
            ],
            trackedFlags: ["a"],
          };
          const target = expectedOf(start, ops);
          const targetHash = configHashOf(target);

          // Gộp làm MỘT event
          const once = applyDelta(
            { snapshot: start, configVersion: 10 },
            {
              fromVersion: 10,
              toVersion: 10 + ops.length,
              configHash: targetHash,
              changes: ops,
            },
          );
          expect(once.kind).toBe("applied");

          // Cùng dãy đó, chia thành nhiều event theo `sizes`
          let cache = { snapshot: start, configVersion: 10 };
          let at = 0;
          let round = 0;
          while (at < ops.length) {
            const size = sizes[round % sizes.length] ?? 1;
            const chunk = ops.slice(at, at + size);
            at += chunk.length;
            round += 1;
            const out = applyDelta(cache, {
              fromVersion: cache.configVersion,
              toVersion: cache.configVersion + chunk.length,
              configHash: configHashOf(expectedOf(cache.snapshot, chunk)),
              changes: chunk,
            });
            expect(out.kind).toBe("applied");
            if (out.kind !== "applied") return;
            cache = {
              snapshot: out.snapshot,
              configVersion: out.configVersion,
            };
          }

          expect(cache.configVersion).toBe(10 + ops.length);
          expect(configHashOf(cache.snapshot)).toBe(targetHash);
          expect(normalizeSnapshot(cache.snapshot)).toEqual(
            normalizeSnapshot(target),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
