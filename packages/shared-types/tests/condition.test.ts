import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_OPERATORS,
  conditionIssue,
  RULE_TYPES,
} from "../src/condition.js";

/**
 * Schema `condition` là hợp đồng giữa bên ghi (Service 2) và bên đánh giá (SDK).
 * Mỗi test dưới đây kiểm một cách mà hợp đồng có thể lỏng ra mà không ai thấy.
 */

describe("bốn loại rule — đúng §2.2", () => {
  it("đủ bốn loại, không thừa không thiếu", () => {
    expect([...RULE_TYPES].sort()).toEqual(
      ["ALL", "ATTRIBUTE_BASED", "SEGMENT", "USER_BASED"].sort(),
    );
  });

  it("đủ mười bốn toán tử", () => {
    expect(ATTRIBUTE_OPERATORS).toHaveLength(14);
  });
});

describe("mỗi loại nhận đúng hình dạng của nó", () => {
  it("ALL chỉ nhận object rỗng", () => {
    expect(conditionIssue("ALL", {})).toBeUndefined();
    expect(conditionIssue("ALL", { userIds: ["u1"] })).toBeDefined();
  });

  it("USER_BASED cần ít nhất một userId", () => {
    expect(conditionIssue("USER_BASED", { userIds: ["u1"] })).toBeUndefined();
    expect(conditionIssue("USER_BASED", { userIds: [] })).toBeDefined();
  });

  it("ATTRIBUTE_BASED nhận AND của điều kiện, toán tử phải nằm trong danh sách", () => {
    expect(
      conditionIssue("ATTRIBUTE_BASED", {
        all: [{ attribute: "country", operator: "in", value: ["VN", "TH"] }],
      }),
    ).toBeUndefined();

    expect(
      conditionIssue("ATTRIBUTE_BASED", {
        all: [{ attribute: "country", operator: "like", value: "V%" }],
      }),
    ).toBeDefined();
  });

  it("SEGMENT trỏ segment bằng UUID", () => {
    expect(
      conditionIssue("SEGMENT", {
        segmentId: "00000000-0000-4000-8000-000000000030",
      }),
    ).toBeUndefined();
    expect(conditionIssue("SEGMENT", { segmentId: "beta" })).toBeDefined();
  });
});

describe(".strict() — trường gửi nhầm không bị nuốt im lặng", () => {
  it("segmentId gửi kèm một rule USER_BASED bị TỪ CHỐI", () => {
    /**
     * Không có `.strict()`, request này parse thành công, `segmentId` biến mất,
     * và rule khớp theo danh sách user trong khi người gọi tin là đã giới hạn
     * theo segment. Kết quả vẫn "hợp lệ" — đó là loại lỗi không ai phát hiện.
     */
    expect(
      conditionIssue("USER_BASED", {
        userIds: ["u1"],
        segmentId: "00000000-0000-4000-8000-000000000030",
      }),
    ).toBeDefined();
  });

  it("trường lạ trong một điều kiện thuộc tính cũng bị từ chối", () => {
    expect(
      conditionIssue("ATTRIBUTE_BASED", {
        all: [
          { attribute: "plan", operator: "eq", value: "pro", negate: true },
        ],
      }),
    ).toBeDefined();
  });
});

describe("thông điệp chỉ ra CHỖ sai", () => {
  it("nêu đường dẫn trong condition, không chỉ nói 'không hợp lệ'", () => {
    /** Người sửa danh sách hai mươi điều kiện cần biết điều kiện NÀO sai */
    expect(
      conditionIssue("ATTRIBUTE_BASED", {
        all: [
          { attribute: "a", operator: "eq", value: "x" },
          { attribute: "b", operator: "nope", value: "y" },
        ],
      }),
    ).toContain("all.1.operator");
  });
});
