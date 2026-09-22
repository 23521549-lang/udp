import { describe, expect, it } from "vitest";
import {
  applyChange,
  applyDelta,
  configHashOf,
  hashVerdict,
  normalizeSnapshot,
  parseSdkConfig,
  parseSdkDelta,
  type Snapshot,
  type SnapshotFlag,
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
        changes: [{ configVersion: 2, kind: "segment", id: "s" }],
      }),
    ).toBeUndefined();
  });
});
