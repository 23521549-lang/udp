import { CONDITION_LIMITS } from "@udp/config";
import { UnprocessableError } from "@udp/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertConditionsSafe,
  assertPatternsSafe,
  assertRegexesSafe,
  setRegexAnalyzer,
} from "../src/modules/rule/regex-safety.js";

/**
 * `regex-safety.ts` ở mức UNIT (T9).
 *
 * `recheck` bị mock, không chạy thật, vì hai ca quan trọng nhất ở đây không kiểm
 * được bằng bản thật một cách tất định: ca `unknown` chỉ xảy ra khi bộ phân tích
 * hết hạn 1 giây (một test phụ thuộc điều đó vừa chậm vừa chập chờn), và ca
 * "không phân tích lại pattern đã có phán quyết" cần đếm số lần gọi.
 *
 * Mỗi ca dùng pattern RIÊNG: cache phán quyết là của module, nên hai ca dùng
 * cùng một chuỗi sẽ ảnh hưởng nhau theo thứ tự chạy.
 */

const { check } = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("recheck", () => ({ check }));

const regex = (value: string) => ({
  attribute: "email",
  operator: "regex",
  value,
});

beforeEach(() => {
  check.mockReset();
});

describe("phán quyết của recheck", () => {
  it("safe ⇒ không ném", async () => {
    check.mockResolvedValue({ status: "safe" });
    await expect(
      assertConditionsSafe({ all: [regex("^u-safe-1$")] }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["exponential", "hàm mũ"],
    ["polynomial", "đa thức"],
  ])("vulnerable %s ⇒ 422 nói đúng loại backtracking", async (type, word) => {
    check.mockResolvedValue({ status: "vulnerable", complexity: { type } });
    const pattern = `^u-vuln-${type}$`;
    const err = await assertConditionsSafe({ all: [regex(pattern)] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnprocessableError);
    expect((err as UnprocessableError).message).toContain(word);
    expect((err as UnprocessableError).message).toContain("ReDoS");
  });

  /**
   * `unknown` = hết hạn phân tích. Bị từ chối như `vulnerable`: một pattern mà bộ
   * phân tích không kết luận được là pattern không nên chạy trên OFREP, endpoint
   * công khai gọi được bằng khoá CLIENT nằm trong trình duyệt.
   */
  it("unknown ⇒ 422 như vulnerable", async () => {
    check.mockResolvedValue({ status: "unknown" });
    await expect(
      assertConditionsSafe({ all: [regex("^u-unknown-1$")] }),
    ).rejects.toThrow(UnprocessableError);
  });

  it("hạn phân tích lấy từ CONDITION_LIMITS, cờ `u`", async () => {
    check.mockResolvedValue({ status: "safe" });
    await assertConditionsSafe({ all: [regex("^u-args-1$")] });
    expect(check).toHaveBeenCalledWith("^u-args-1$", "u", {
      timeout: CONDITION_LIMITS.regexCheckTimeoutMs,
    });
  });
});

describe("seam analyze và cache phán quyết", () => {
  it("cache: cùng pattern không bị phân tích lại", async () => {
    const analyze = vi.fn().mockResolvedValue(undefined);
    const restore = setRegexAnalyzer(analyze);
    try {
      await assertPatternsSafe(["^cache-a$"]);
      await assertPatternsSafe(["^cache-a$"]);
      await assertPatternsSafe(["^cache-a$", "^cache-b$"]);
      expect(analyze.mock.calls.map((c) => c[0])).toEqual([
        "^cache-a$",
        "^cache-b$",
      ]);
    } finally {
      restore();
    }
  });

  it("hoàn nguyên seam trả lại bộ phân tích thật", async () => {
    const restore = setRegexAnalyzer(() => Promise.resolve("giả lập"));
    restore();
    check.mockResolvedValue({ status: "safe" });
    await assertPatternsSafe(["^restored-1$"]);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("chọn pattern", () => {
  it("assertConditionsSafe chỉ lấy operator `regex` trong `all`", async () => {
    const analyze = vi.fn().mockResolvedValue(undefined);
    const restore = setRegexAnalyzer(analyze);
    try {
      await assertConditionsSafe({
        all: [
          { attribute: "plan", operator: "eq", value: "^not-a-pattern$" },
          { attribute: "n", operator: "gt", value: 3 },
          regex("^pick-me$"),
        ],
      });
      expect(analyze.mock.calls.map((c) => c[0])).toEqual(["^pick-me$"]);
    } finally {
      restore();
    }
  });

  /**
   * Segment không có `ruleType`. Gọi `assertRegexesSafe` với nó thì bộ lọc
   * `ruleType === "ATTRIBUTE_BASED"` im lặng kiểm 0 pattern và `(a|a)*$` lọt lên
   * OFREP — đúng hình dạng R07 (a). Ca này ghim lại vì sao đường segment PHẢI
   * dùng `assertConditionsSafe`.
   */
  it("assertRegexesSafe bỏ qua rule không phải ATTRIBUTE_BASED", async () => {
    const analyze = vi.fn().mockResolvedValue(undefined);
    const restore = setRegexAnalyzer(analyze);
    try {
      await assertRegexesSafe([
        { ruleType: "SEGMENT", condition: { all: [regex("^ignored$")] } },
        { ruleType: "ATTRIBUTE_BASED", condition: { all: [regex("^seen$")] } },
      ]);
      expect(analyze.mock.calls.map((c) => c[0])).toEqual(["^seen$"]);
    } finally {
      restore();
    }
  });

  it(`quá ${String(CONDITION_LIMITS.regexPatternsPerWrite)} pattern khác nhau ⇒ 422, KHÔNG phân tích cái nào`, async () => {
    const analyze = vi.fn().mockResolvedValue(undefined);
    const restore = setRegexAnalyzer(analyze);
    try {
      const patterns = Array.from(
        { length: CONDITION_LIMITS.regexPatternsPerWrite + 1 },
        (_, i) => `^over-${String(i)}$`,
      );
      await expect(assertPatternsSafe(patterns)).rejects.toThrow(/tối đa/);
      expect(analyze).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("pattern trùng nhau đếm là MỘT: 20 bản của cùng chuỗi vẫn qua", async () => {
    const analyze = vi.fn().mockResolvedValue(undefined);
    const restore = setRegexAnalyzer(analyze);
    try {
      const same = Array.from(
        { length: CONDITION_LIMITS.regexPatternsPerWrite + 5 },
        () => "^dup-1$",
      );
      await expect(assertPatternsSafe(same)).resolves.toBeUndefined();
      expect(analyze).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
