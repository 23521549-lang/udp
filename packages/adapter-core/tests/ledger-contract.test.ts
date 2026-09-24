import { describe, expect, it } from "vitest";
import {
  LEDGER_CONTRACT_CHECKS,
  runLedgerContract,
} from "../src/contract/ledger.js";
import { InMemoryLedger } from "../src/testing/in-memory-ledger.js";

/**
 * [v4.10] Bộ hợp đồng của cổng `Ledger`, chạy trên hiện thực thứ nhất.
 *
 * Hiện thực thứ hai (`PrismaLedger`, ở Service 1) chạy **đúng danh sách này** ở pha P9.
 * Đó là toàn bộ lý do bộ này là dữ liệu: nếu hai hiện thực lệch ngữ nghĩa thì 129 trong
 * 130 ô của lưới tầng 1 mất giá trị chứng minh, và điều đó không lộ ra ở bất kỳ ô nào —
 * chúng đều xanh, chỉ là chúng đang chứng minh một thứ khác.
 */

runLedgerContract(
  { describe, it },
  "InMemoryLedger",
  () => new InMemoryLedger(),
);

/**
 * Meta-test: hợp đồng có RĂNG.
 *
 * Một phép kiểm rỗng trong một `describe()` cứng trông y như một phép thật. Ở đây số phép
 * là một hằng số kiểm được, và mỗi phép phải thật sự khẳng định điều gì đó — nên "giảm
 * số phép" là một test đỏ chứ không phải một dòng biến mất trong diff.
 */
describe("meta — bộ hợp đồng Ledger", () => {
  it("có đúng 16 phép, tên không trùng", () => {
    expect(LEDGER_CONTRACT_CHECKS).toHaveLength(16);
    expect(new Set(LEDGER_CONTRACT_CHECKS.map((c) => c.name)).size).toBe(16);
  });

  it("mọi phép đều có thân hàm thật, không phép nào rỗng", () => {
    for (const check of LEDGER_CONTRACT_CHECKS) {
      expect(check.run.length, check.name).toBe(1);
      expect(check.run.toString().length, check.name).toBeGreaterThan(80);
    }
  });

  /**
   * Chốt rằng bộ hợp đồng thật sự BẮT được một hiện thực sai.
   *
   * Đây là phép kiểm quan trọng nhất của cả pha: một bộ hợp đồng mà không phép nào đỏ
   * trước một sổ hỏng thì nó chỉ là một danh sách tên. Sổ dưới đây nhận mọi lời gọi và
   * không bao giờ ném — đúng cách một hiện thực "dễ tính" trông như thế nào.
   */
  it("một sổ luôn-đồng-ý làm ĐỎ phần lớn các phép", async () => {
    const permissive = {
      intend: () => Promise.resolve(),
      markCreated: () => Promise.resolve(),
      markReady: () => Promise.resolve(),
      markDeleting: () => Promise.resolve(),
      markDeleted: () => Promise.resolve(),
      markOrphanSuspected: () => Promise.resolve(),
      byKey: () => Promise.resolve(null),
      rowsOf: () => Promise.resolve([]),
    };

    let failed = 0;
    for (const check of LEDGER_CONTRACT_CHECKS) {
      try {
        await check.run(() => permissive);
      } catch {
        failed += 1;
      }
    }
    /**
     * Con số CHÍNH XÁC, không phải một ngưỡng lỏng: 14 trong 16. Hai phép còn xanh có lý
     * do đúng và đã soát — "byKey trả null cho khoá không có" (sổ luôn-đồng-ý trả null,
     * đó là hành vi ĐÚNG) và "lý do của ORPHAN_SUSPECTED không bị nuốt" (chỉ khẳng định
     * khi hiện thực có `orphanReasonOf`, một năng lực tuỳ chọn). Chốt số chính xác nghĩa
     * là làm yếu bất kỳ phép nào cũng là một test đỏ.
     */
    expect(failed).toBe(14);
  });
});
