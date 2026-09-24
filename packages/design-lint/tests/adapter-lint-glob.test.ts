import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [v4.10] Glob của khối lint adapter phải khớp ÍT NHẤT một tệp thật.
 *
 * Đây là ô đã bị dời hai lần, và ghi lại lý do dời để việc dời không thành việc quên:
 *
 *  - **P11** viết khối lint lẽ ra đã bật, nhưng lúc đó chưa có thư mục adapter nào. Một
 *    khối lint với glob không khớp tệp nào là một khối **xanh vĩnh viễn** — đúng loại bảo
 *    đảm tệ nhất, vì nó cho cảm giác có một ràng buộc đang chạy.
 *  - **P17** mở `include` của vitest cho `src/modules/**`, nhưng cũng chưa có adapter nên
 *    ô này vẫn chưa dựng được.
 *  - **P19** có adapter thật đầu tiên, nên cả hai món được trả ở đây.
 *
 * Chỗ dành sẵn cũ ghi glob `adapters/` số nhiều, trong khi cây thư mục §1.6 đặt adapter ở
 * `modules/<domain>-adapter/`. Hai chuỗi đó khác nhau đúng một chữ, và khác nhau đủ để
 * khối lint không bao giờ áp cho tệp nào.
 */

const REPO = resolve(import.meta.dirname, "../../..");
const ESLINT_CONFIG = join(REPO, "eslint.config.mjs");

/** Glob mà khối lint adapter dùng — đọc từ chính tệp cấu hình */
const EXPECTED_GLOB = '"**/modules/*-adapter/**/*.ts"';

/** Mọi tệp `.ts` nằm dưới một thư mục `<x>-adapter/` trong cây thật */
function adapterFiles(): string[] {
  const roots = [
    join(REPO, "services/core-backend/src/modules"),
    join(REPO, "services/flag-service/src/modules"),
    join(REPO, "services/pd-controller/src"),
  ];
  const out: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith("-adapter")) continue;
      out.push(...tsUnder(join(root, entry)));
    }
  }
  return out;
}

function tsUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsUnder(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("khối lint adapter áp cho tệp THẬT", () => {
  it("cấu hình eslint khai đúng glob của cây thật", () => {
    const source = readFileSync(ESLINT_CONFIG, "utf8");
    expect(
      source.includes(EXPECTED_GLOB),
      `không thấy glob ${EXPECTED_GLOB} trong eslint.config.mjs`,
    ).toBe(true);
  });

  it("glob đó khớp ít nhất một tệp thật", () => {
    const files = adapterFiles();
    expect(
      files.length,
      "không tệp nào nằm dưới `*-adapter/` ⇒ khối lint xanh vĩnh viễn",
    ).toBeGreaterThan(0);
  });

  /**
   * Và khối lint KHÔNG được khai glob cũ.
   *
   * Nếu ai đó thêm lại `adapters/` bên cạnh glob đúng, lint vẫn xanh và ô trên vẫn xanh —
   * nhưng người đọc cấu hình sẽ thấy hai glob và không biết cái nào đang áp.
   */
  it("không còn glob `adapters/` số nhiều trong cấu hình", () => {
    const source = readFileSync(ESLINT_CONFIG, "utf8");
    const stale = /["']\*\*\/adapters\//.test(source);
    expect(stale, "glob `adapters/` số nhiều không khớp cây thật").toBe(false);
  });

  /**
   * Mọi adapter thật phải có một contract test NẰM CẠNH nó.
   *
   * Bất biến I28 nói mọi adapter đều qua bộ hợp đồng. Chốt này là phần kiểm được của câu
   * đó ở mức thư mục: một adapter mới không kèm contract test là một adapter không ai
   * chạy bộ hợp đồng cho, và không có gì đỏ để nhắc.
   */
  it("mỗi thư mục adapter có một contract test cạnh nó", () => {
    const files = adapterFiles();
    /**
     * `dirname` chứ KHÔNG cắt chuỗi theo `\`.
     *
     * Bản đầu của phép này cắt theo dấu gạch chéo ngược của Windows, nên nó xanh trên máy
     * phát triển và đỏ trên CI Linux — một phép kiểm chỉ đúng ở một nửa số nơi nó chạy.
     */
    const dirs = new Set(
      files.filter((f) => f.endsWith("index.ts")).map((f) => dirname(f)),
    );
    const missing = [...dirs].filter(
      (d) =>
        !files.some(
          (f) => dirname(f) === d && f.endsWith("contract.test.ts"),
        ),
    );
    expect(missing).toEqual([]);
  });
});
