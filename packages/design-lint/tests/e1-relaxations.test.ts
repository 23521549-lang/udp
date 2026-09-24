import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONTRACT_RELAXATIONS } from "@udp/adapter-core/contract";
import { describe, expect, it } from "vitest";

/**
 * [v4.10] Số liệu E1 — số lần phải NỚI LỎNG bộ test hợp đồng.
 *
 * §13.2 viết thẳng: *"nếu bộ test phải nới lỏng để `SaaSAdapter` lọt, thì khung adapter đã
 * gò ép, và số lần phải nới lỏng chính là số liệu báo cáo ở E1"*. Nên con số đó không phải
 * một chi tiết nội bộ mà là một **kết quả** của luận văn, và nó phải đọc được mà không
 * phải mở mã nguồn.
 *
 * Hai bản khai, và chốt này giữ chúng không trôi khỏi nhau:
 *
 *  - `CONTRACT_RELAXATIONS` trong `packages/adapter-core/src/contract/index.ts` — nguồn
 *    sự thật, và là thứ `runXContract` đọc lúc chạy.
 *  - `docs/E1-relaxations.json` — bản báo cáo.
 *
 * Thêm một hàng ở một bên mà quên bên kia là một test đỏ. Không có chốt này, con số trong
 * luận văn và con số trong mã có thể khác nhau, và bản báo cáo sẽ là bản ai đó nhớ cập
 * nhật lần cuối.
 */

const REPORT = resolve(import.meta.dirname, "../../../docs/E1-relaxations.json");

interface E1Report {
  measuredAt: string;
  relaxations: { check: string; adapterKind: string; reason: string }[];
  count: number;
}

function report(): E1Report {
  return JSON.parse(readFileSync(REPORT, "utf8")) as E1Report;
}

describe("E1 — sổ nới lỏng, hai bản khai không được lệch", () => {
  it("tệp báo cáo là JSON hợp lệ và có ba trường bắt buộc", () => {
    const r = report();
    expect(typeof r.measuredAt).toBe("string");
    expect(Array.isArray(r.relaxations)).toBe(true);
    expect(typeof r.count).toBe("number");
  });

  it("`count` khớp độ dài `relaxations` của chính tệp", () => {
    /**
     * Một `count` viết tay lệch với danh sách là cách con số báo cáo sai mà không ai
     * thấy: người đọc luận văn đọc `count`, còn người đọc mã đếm danh sách.
     */
    const r = report();
    expect(r.count).toBe(r.relaxations.length);
  });

  it("danh sách trong tệp khớp CONTRACT_RELAXATIONS của mã", () => {
    const r = report();
    const inCode = CONTRACT_RELAXATIONS.map(
      (x) => `${x.adapterKind}|${x.check}`,
    ).sort();
    const inDoc = r.relaxations
      .map((x) => `${x.adapterKind}|${x.check}`)
      .sort();
    expect(inDoc).toEqual(inCode);
  });

  /**
   * MỌI hàng phải có lý do KHÔNG RỖNG.
   *
   * §13.2 nói nới lỏng phải là "một hàng ở đây, có lý do" — một hàng không lý do là một
   * lần nới lỏng không ai soát được, và nó đếm vào E1 như thể nó đã được cân nhắc.
   */
  it("mọi hàng nới lỏng đều có lý do không rỗng", () => {
    const empty = CONTRACT_RELAXATIONS.filter(
      (x) => x.reason.trim().length === 0,
    );
    expect(empty.map((x) => x.check)).toEqual([]);

    const emptyInDoc = report().relaxations.filter(
      (x) => x.reason.trim().length === 0,
    );
    expect(emptyInDoc.map((x) => x.check)).toEqual([]);
  });
});
