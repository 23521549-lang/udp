import { describe, expect, it } from "vitest";
import {
  createFlagFields,
  updateFlagFields,
  updateFlagRefine,
} from "../src/flag-api.js";

describe("key variant — tiền tố __ dành cho nhãn stats", () => {
  const withVariant = (key: string) =>
    createFlagFields.safeParse({
      key: "checkout",
      flagType: "STRING",
      variants: [
        { key, value: "a" },
        { key: "b", value: "b" },
      ],
    }).success;

  it.each(["__x", "__disabled__", "__error__", "__proto__"])(
    "%s ⇒ lỗi",
    (key) => {
      expect(withVariant(key)).toBe(false);
    },
  );

  it("một dấu _ đầu vẫn hợp lệ", () => {
    expect(withVariant("_x")).toBe(true);
  });
});

describe("permanent", () => {
  it("nhận ở tạo flag", () => {
    expect(
      createFlagFields.safeParse({
        key: "kill-switch",
        flagType: "BOOLEAN",
        permanent: true,
      }).success,
    ).toBe(true);
  });

  it("PATCH chỉ đổi permanent là một thay đổi hợp lệ", () => {
    const patch = updateFlagFields.superRefine(updateFlagRefine);
    const at = "2026-09-22T00:00:00.000Z";
    expect(
      patch.safeParse({ lastKnownUpdatedAt: at, permanent: false }).success,
    ).toBe(true);
    expect(patch.safeParse({ lastKnownUpdatedAt: at }).success).toBe(false);
  });
});
