import { describe, expect, it } from "vitest";
import {
  createSegmentFields,
  updateSegmentFields,
} from "../src/segment-api.js";

/**
 * Postgres không lưu được NUL hay surrogate lẻ (R7-3: 08P01 / 22P05) — chuỗi như
 * vậy phải bị chặn ở biên thành 400, ở MỌI chuỗi của body, không lọt xuống thành 500.
 */

const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);

const valid = {
  name: "beta-testers",
  description: "Người dùng gói premium",
  conditions: {
    all: [{ attribute: "country", operator: "eq", value: "VN" }],
    userIds: ["u-1", "u-2"],
  },
};

const create = (body: unknown) => createSegmentFields.strict().safeParse(body);

describe("createSegmentFields", () => {
  it("body hợp lệ, kể cả ký tự ngoài BMP (cặp surrogate đúng)", () => {
    expect(create(valid).success).toBe(true);
    expect(create({ ...valid, name: "nhóm 😀" }).success).toBe(true);
  });

  it.each([
    ["tên", { ...valid, name: `beta${NUL}` }],
    ["mô tả", { ...valid, description: `x${NUL}` }],
    [
      "userId",
      { ...valid, conditions: { ...valid.conditions, userIds: [`u${NUL}`] } },
    ],
    [
      "giá trị điều kiện",
      {
        ...valid,
        conditions: {
          ...valid.conditions,
          all: [{ attribute: "country", operator: "in", value: [`V${NUL}N`] }],
        },
      },
    ],
  ])("U+0000 trong %s ⇒ lỗi", (_label, body) => {
    expect(create(body).success).toBe(false);
  });

  it("surrogate lẻ ⇒ lỗi", () => {
    expect(create({ ...valid, name: `a${LONE_SURROGATE}` }).success).toBe(
      false,
    );
    expect(
      create({
        ...valid,
        conditions: { ...valid.conditions, userIds: [LONE_SURROGATE] },
      }).success,
    ).toBe(false);
  });
});

describe("updateSegmentFields — PUT thay toàn bộ", () => {
  it("bắt buộc lastKnownUpdatedAt và description (null được)", () => {
    const put = (body: unknown) => updateSegmentFields.strict().safeParse(body);
    const at = "2026-09-22T00:00:00.000Z";

    expect(put({ ...valid, lastKnownUpdatedAt: at }).success).toBe(true);
    expect(
      put({ ...valid, description: null, lastKnownUpdatedAt: at }).success,
    ).toBe(true);
    expect(put(valid).success).toBe(false);
    const { description: _omitted, ...withoutDescription } = valid;
    expect(put({ ...withoutDescription, lastKnownUpdatedAt: at }).success).toBe(
      false,
    );
  });
});
