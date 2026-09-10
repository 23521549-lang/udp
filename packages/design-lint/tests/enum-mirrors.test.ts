import { describe, expect, it } from "vitest";

/**
 * Những danh sách PHẢI có bản thứ hai — và chốt giữ hai bản không trôi khỏi nhau.
 *
 * `@udp/shared-types` không được import `@udp/db` (đó là chỗ duy nhất tạo được
 * vòng `db → shared-types → db`), nên mọi enum mà cả SDK lẫn database cùng cần
 * đều phải có một bản chép trong shared-types. Chép thì trôi — đúng hình dạng
 * của lỗi v3 ở §7.1, khi hai tập status khác nhau làm session PAUSED không bao
 * giờ được claim. `design-lint` là package DUY NHẤT thấy được cả hai bên, nên
 * chốt nằm ở đây.
 */
describe("enum của Prisma và bản chép trong shared-types", () => {
  it("RULE_TYPES trùng đúng enum RuleType", async () => {
    const { RuleType } = await import("@udp/db");
    const { RULE_TYPES } = await import("@udp/shared-types");

    expect(new Set(RULE_TYPES)).toEqual(new Set(Object.values(RuleType)));
  });

  it("FLAG_TYPES trùng đúng enum FlagType", async () => {
    /**
     * Một kiểu flag có trong database mà không có ở đây thì `createFlagSchema`
     * không có validator cho nó; ngược lại thì Portal cho chọn một kiểu mà
     * database từ chối.
     */
    const { FlagType } = await import("@udp/db");
    const { FLAG_TYPES } = await import("@udp/shared-types");

    expect(new Set(FLAG_TYPES)).toEqual(new Set(Object.values(FlagType)));
  });
});
