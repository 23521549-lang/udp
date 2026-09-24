import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [v4.10] Cổng P23 — G-02 và G-03: nợ kiểu và test bị tắt KHÔNG được mọc thêm trong im lặng.
 *
 * Hai cổng này đứng ngoài mọi bất biến của sản phẩm, và đó chính là lý do chúng cần một
 * phép kiểm riêng: chúng canh **quá trình**, không canh hệ thống.
 *
 *  - **G-02**: một `it.skip` để lại sau khi sửa lỗi là một phép kiểm không bao giờ chạy,
 *    và bộ test vẫn báo "xanh". Số test thì không tụt, nên `G-01` không thấy gì.
 *  - **G-03**: `@ts-expect-error` và `as any` là hai cách hợp pháp để nói "ở đây tôi biết
 *    hơn compiler". Vấn đề không phải một lần dùng, mà là **số lần** tăng dần: sau vài
 *    plan, nơi nào còn được `tsc` canh trở thành một câu hỏi không ai trả lời được.
 *
 * Cách canh là **ghim con số**, không phải cấm tuyệt đối. Cấm tuyệt đối thì một khẳng
 * định kiểu-âm (`@ts-expect-error` để chứng minh một lời gọi KHÔNG biên dịch được) phải
 * viết bằng cách khác, tệ hơn. Ghim số thì thêm một cái là một quyết định nhìn thấy
 * được: sửa con số ở đây, và người sửa phải nói vì sao trong commit.
 *
 * Mỗi `@ts-expect-error` mang một **mã `TSX-nn`**, vì một chỉ thị không mã là một chỉ thị
 * không ai đọc lại: `tsc` báo "Unused '@ts-expect-error' directive" khi dòng dưới nó đã
 * biên dịch được, và lúc đó mã là cách tìm ra nó thuộc khẳng định nào.
 */

const ROOT = resolve(import.meta.dirname, "../../..");

/**
 * Baseline ĐÃ ĐO (P23, 24/09/2026) — đổi nó là một quyết định, không phải một lần sửa test.
 *
 * Sáu chỉ thị: TSX-01..03 ở `cluster-access.test.ts` (ba SA của §12.2, và
 * `ReadOnlyKubernetesClient` không có `write`), TSX-04 ở `day2-drift.test.ts` (tầng kiểu
 * của I32 chiều c), TSX-05/06 ở `openfeature-provider` (kiểu của host và của constructor).
 */
const TS_EXPECT_ERROR_BASELINE = 6;

/** Lệnh gọi `git` đọc danh sách tệp được theo dõi — không quét `node_modules` */
function trackedSources(): string[] {
  const out = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scan(pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const rel of trackedSources()) {
    const source = readFileSync(resolve(ROOT, rel), "utf8");
    source.split("\n").forEach((text, i) => {
      if (pattern.test(text)) hits.push({ file: rel, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

describe("G-02 — không test nào bị tắt", () => {
  /**
   * Quét dạng LỜI GỌI (`it.skip(`), không quét chuỗi `it.skip` trần.
   *
   * Ba chỗ trong kho nhắc `it.skip` trong CHÚ THÍCH, và cả ba nhắc để nói "không được
   * làm thế" — chính bộ hợp đồng giải thích vì sao một phép bị nới lỏng phải là một hàng
   * trong `CONTRACT_RELAXATIONS` chứ không phải một `it.skip` rải rác. Một phép kiểm bắt
   * cả chú thích sẽ buộc người ta bỏ câu giải thích đi để test xanh, tức nó làm mã TỆ hơn.
   */
  it("0 lời gọi only / skip / todo trong toàn bộ test", () => {
    const hits = scan(
      /\b(it|test|describe)\.(only|skip|todo)\s*\(|\bit\.each\s*\.\s*skip\b/,
    );
    expect(
      hits.map((h) => `${h.file}:${String(h.line)}`),
      "một test bị tắt vẫn đếm là 'xanh' trong báo cáo",
    ).toEqual([]);
  });
});

describe("G-03 — nợ kiểu ghim bằng số, mỗi ngoại lệ có mã", () => {
  it("số @ts-expect-error đúng baseline đã đo", () => {
    const hits = scan(/@ts-expect-error/);
    /** Chỉ dòng CHỈ THỊ, không tính chú thích bàn về nó */
    const directives = hits.filter((h) => /^\s*\/\/\s*@ts-expect-error/.test(h.text) || h.text.startsWith("// @ts-expect-error"));
    expect(
      directives.length,
      `thêm hoặc bớt chỉ thị thì sửa TS_EXPECT_ERROR_BASELINE và nói vì sao: ${directives
        .map((h) => `${h.file}:${String(h.line)}`)
        .join(", ")}`,
    ).toBe(TS_EXPECT_ERROR_BASELINE);
  });

  it("mỗi chỉ thị mang một mã TSX-nn, và không mã nào trùng", () => {
    const hits = scan(/^\s*\/\/\s*@ts-expect-error/);
    const codes = hits.map((h) => /TSX-(\d\d)/.exec(h.text)?.[0] ?? null);
    const missing = hits
      .filter((_, i) => codes[i] === null)
      .map((h) => `${h.file}:${String(h.line)}`);
    expect(missing, "chỉ thị không mã là chỉ thị không ai đọc lại").toEqual([]);
    const present = codes.filter((c): c is string => c !== null);
    expect(new Set(present).size).toBe(present.length);
  });

  /**
   * `as any` và `TODO`/`FIXME`: đếm dạng MÃ, hiện là 0.
   *
   * Cùng lý lẽ với G-02 về chú thích: kho có một chú thích giải thích vì sao `(req as any)`
   * là cách sai, và nó phải được giữ.
   */
  it("0 `as any` và 0 TODO/FIXME trong mã", () => {
    const anyHits = scan(/\bas\s+any\b/).filter(
      (h) => !h.text.startsWith("*") && !h.text.startsWith("//"),
    );
    const todoHits = scan(/\b(TODO|FIXME)\b/).filter(
      (h) => !h.text.includes("không có TODO"),
    );
    expect(anyHits.map((h) => `${h.file}:${String(h.line)}`)).toEqual([]);
    expect(todoHits.map((h) => `${h.file}:${String(h.line)}`)).toEqual([]);
  });
});
