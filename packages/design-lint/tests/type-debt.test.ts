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
 * Dạng LỜI GỌI của một phép kiểm bị tắt, tách ra thành hằng có tên để **ô đối chứng**
 * dưới cùng kiểm được chính nó.
 *
 * Quét dạng lời gọi chứ không quét chuỗi trần: ba chỗ trong kho nhắc tên những thứ này
 * trong chú thích, và cả ba nhắc để nói "không được làm thế" (bộ hợp đồng giải thích vì
 * sao một phép bị nới lỏng phải là một hàng trong `CONTRACT_RELAXATIONS`). Một phép kiểm
 * bắt cả chú thích sẽ buộc người ta bỏ câu giải thích đi để test xanh, tức nó làm mã TỆ hơn.
 */
const DISABLED_TEST_CALL =
  /\b(it|test|describe)\.(only|skip|todo)\s*\(|\bit\.each\s*\.\s*skip\b/;

const AS_ANY = /\bas\s+any\b/;
const TODO_MARK = /\b(TODO|FIXME)\b/;

/**
 * Tệp NÀY tự loại trừ, theo ĐÚNG đường dẫn chứ không theo một mẫu rộng.
 *
 * Lý do: nó chứa chính những mẫu nó đi tìm — trong chú thích giải thích luật, và trong
 * tên của các phép kiểm. Đây là một quyết định nhìn thấy được, cùng hình dạng với việc
 * loại trừ `packages/db/src/generated/`.
 *
 * Nó cũng là một bài học về chính cổng này: bốn phép ở đây XANH ở lần chạy đầu vì tệp
 * còn chưa được `git` theo dõi, nên `git ls-files` không liệt kê nó và nó **không thấy
 * chính mình**. Chỉ tới lượt CI trên database sạch — sau khi commit — hai phép mới đỏ.
 * Một cổng xanh vì không nhìn thấy mình là một cổng chưa từng chạy.
 */
const SELF = "packages/design-lint/tests/type-debt.test.ts";

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
    if (rel === SELF) continue;
    const source = readFileSync(resolve(ROOT, rel), "utf8");
    source.split("\n").forEach((text, i) => {
      if (pattern.test(text))
        hits.push({ file: rel, line: i + 1, text: text.trim() });
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
    const hits = scan(DISABLED_TEST_CALL);
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
    const directives = hits.filter(
      (h) =>
        /^\s*\/\/\s*@ts-expect-error/.test(h.text) ||
        h.text.startsWith("// @ts-expect-error"),
    );
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
   * Ô ĐỐI CHỨNG — cùng phép quét PHẢI bắt được dạng lời gọi, và PHẢI bỏ qua chuỗi trần.
   *
   * Không có ô này thì một lần "sửa cho hết đỏ" có thể làm regex yếu đi (ví dụ đòi thêm
   * một dấu cách) và cả ba phép trên xanh vĩnh viễn mà không kiểm gì. Cùng lý lẽ với ô
   * đối chứng của phép quét sentinel ở `credential-sentinel.test.ts`.
   */
  it("đối chứng: phép quét BẮT dạng lời gọi và BỎ QUA chuỗi trần", () => {
    expect(DISABLED_TEST_CALL.test('it.skip("x", () => {})')).toBe(true);
    expect(DISABLED_TEST_CALL.test("describe.only(")).toBe(true);
    expect(DISABLED_TEST_CALL.test("test.todo (")).toBe(true);
    /** Chuỗi trần trong chú thích: KHÔNG được bắt */
    expect(DISABLED_TEST_CALL.test("ba chỗ nhắc it.skip trong chú thích")).toBe(
      false,
    );
    expect(AS_ANY.test("const x = y as any;")).toBe(true);
    expect(AS_ANY.test("chuỗi nói về asAnyThing")).toBe(false);
  });

  /**
   * `as any` và `TODO`/`FIXME`: đếm dạng MÃ, hiện là 0.
   *
   * Cùng lý lẽ với G-02 về chú thích: kho có một chú thích giải thích vì sao `(req as any)`
   * là cách sai, và nó phải được giữ.
   */
  it("0 `as any` và 0 TODO/FIXME trong mã", () => {
    const anyHits = scan(AS_ANY).filter(
      (h) => !h.text.startsWith("*") && !h.text.startsWith("//"),
    );
    const todoHits = scan(TODO_MARK).filter(
      (h) => !h.text.includes("không có TODO"),
    );
    expect(anyHits.map((h) => `${h.file}:${String(h.line)}`)).toEqual([]);
    expect(todoHits.map((h) => `${h.file}:${String(h.line)}`)).toEqual([]);
  });
});
