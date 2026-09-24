import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [v4.10] Cổng P14 — oracle phải ĐỘC LẬP với resolver, ở hai tầng.
 *
 * Differential testing chỉ có giá trị khi hai hiện thực độc lập. Hai cách nó mất độc lập,
 * và cả hai đều xảy ra một cách tự nhiên nếu không có chốt:
 *
 *  1. **Độc lập ở tầng mã.** Oracle import một hàm của resolver "cho khỏi lặp" — và từ đó
 *     nó không còn phán xử gì, nó chỉ khẳng định một hàm bằng chính nó.
 *  2. **Độc lập ở tầng THỜI GIAN.** Oracle viết SAU resolver gần như chắc chắn mang cùng
 *     những lỗi của resolver, vì người viết đọc mã trước rồi mới viết. Lúc đó differential
 *     test là một phép "hai bản chép giống nhau": xanh, tốn thời gian, không phát hiện gì.
 *
 * Chốt thứ hai là chốt ít ai nghĩ tới, và nó là lý do plan tách P14 thành một commit
 * riêng nằm TRƯỚC P15.
 *
 * **Vì sao không phải `dependency-cruiser`:** plan gọi tên công cụ đó, nhưng repo này chưa
 * cài nó (I26/I35 nhắc nó như một công cụ CI dự kiến). Thêm một công cụ mới cho đúng một
 * luật là một quyết định về hạ tầng, còn `design-lint` đã là nơi ở của mọi luật cấu trúc
 * và đã có sẵn lối đọc mã nguồn. Chọn `design-lint`, và ghi lại lý do ở đây để lần sau
 * không ai đi tìm một cấu hình `dependency-cruiser` không tồn tại.
 */

const REPO = resolve(import.meta.dirname, "../../..");
const ORACLE_DIR = join(REPO, "services/core-backend/tests/oracle");
const RESOLVER_DIR = "services/core-backend/src/modules/capability";

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Mọi specifier của `import`/`export ... from` trong một tệp */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    m = re.exec(source);
  }
  /** `import "x"` không có `from`, và `await import("x")` động */
  const bare = /(?:^|\n)\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let b: RegExpExecArray | null = bare.exec(source);
  while (b !== null) {
    const spec = b[1] ?? b[2];
    if (spec !== undefined) out.push(spec);
    b = bare.exec(source);
  }
  return out;
}

describe("oracle độc lập ở tầng mã", () => {
  it("có ít nhất một tệp trong tests/oracle — nếu không, phép kiểm này vô nghĩa", () => {
    /**
     * Không có phép này, cả nhóm sẽ xanh vĩnh viễn nếu thư mục oracle bị đổi tên: một
     * danh sách rỗng thoả mọi khẳng định "không tệp nào import X".
     */
    expect(tsFilesUnder(ORACLE_DIR).length).toBeGreaterThan(0);
  });

  it("KHÔNG tệp nào trong tests/oracle import module capability của resolver", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(ORACLE_DIR)) {
      for (const spec of importsOf(file)) {
        /** Bắt cả đường dẫn tương đối lẫn alias: chỉ cần chuỗi `modules/capability` */
        if (spec.includes("modules/capability")) {
          offenders.push(`${file} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Và nó cũng KHÔNG được import bất cứ gì từ `src/` của Service 1.
   *
   * Luật hẹp ("không import `capability/**`") để ngỏ một đường lách hiển nhiên: oracle
   * import một helper ở `src/modules/domain/` mà helper đó lại gọi resolver. Luật rộng
   * hơn dễ phát biểu và dễ giữ: oracle chỉ được dùng KIỂU từ `@udp/shared-types`.
   */
  it("KHÔNG tệp nào trong tests/oracle import src/ của Service 1", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(ORACLE_DIR)) {
      for (const spec of importsOf(file)) {
        if (/(^|\/)\.\.\/\.\.\/src\//.test(spec) || spec.includes("/src/")) {
          offenders.push(`${file} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Commit đầu tiên ĐƯA VÀO một đường dẫn, hay `null` nếu chưa có commit nào */
function firstCommitOf(pathspec: string): { hash: string; at: number } | null {
  const out = execFileSync(
    "git",
    [
      "log",
      "--diff-filter=A",
      "--reverse",
      "--format=%H %ct",
      "--",
      pathspec,
    ],
    { cwd: REPO, encoding: "utf8" },
  ).trim();
  if (out === "") return null;
  const first = out.split("\n")[0] ?? "";
  const [hash, ct] = first.split(" ");
  if (hash === undefined || ct === undefined) return null;
  return { hash, at: Number(ct) };
}

describe("oracle độc lập ở tầng thời gian", () => {
  it("oracle ĐÃ được commit — một oracle chưa commit không chứng minh thứ tự nào", () => {
    const oracle = firstCommitOf("services/core-backend/tests/oracle");
    expect(oracle, "chưa có commit nào đưa tests/oracle vào").not.toBeNull();
  });

  /**
   * Resolver phải xuất hiện SAU oracle.
   *
   * Khi resolver chưa tồn tại (trạng thái ngay sau P14), phép này đúng một cách tầm
   * thường — và nói ra điều đó thay vì để người đọc tưởng nó đang kiểm gì: giá trị của nó
   * bắt đầu từ P15, và nó sẽ đỏ nếu ai đó viết resolver trước rồi mới viết oracle.
   */
  it("commit đưa resolver vào KHÔNG được sớm hơn commit đưa oracle vào", () => {
    const oracle = firstCommitOf("services/core-backend/tests/oracle");
    const resolver = firstCommitOf(RESOLVER_DIR);
    expect(oracle).not.toBeNull();
    if (resolver === null) {
      /** Chưa có resolver: trạng thái hợp lệ của P14, và phép kiểm nói rõ như vậy */
      expect(resolver).toBeNull();
      return;
    }
    expect(
      (oracle as { at: number }).at,
      `oracle ${String((oracle as { hash: string }).hash)} phải không muộn hơn ` +
        `resolver ${resolver.hash}`,
    ).toBeLessThanOrEqual(resolver.at);
  });
});
