import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * INV-23.7 — hai nhãn stats `__disabled__` và `__error__` chỉ được KHAI ở
 * `@udp/shared-types/sdk-stats`.
 *
 * Vì sao đáng một lint riêng: hai chuỗi này là khoá của một hàng trong
 * `FlagEvaluationStat`, và `UNUSED`/`SETTLED` (§6.7) đọc chúng để phân biệt "flag
 * đang tắt" với "flag đã chốt một variant". Chép chuỗi ra chỗ thứ hai thì không có
 * gì vỡ ngay: nó vỡ vào ngày ai đó đổi nhãn ở nguồn, hai bên đếm vào hai hàng
 * khác nhau, và cảnh báo cleanup lặng lẽ sai. Đây đúng hình dạng lỗi mà
 * `enum-mirrors` và `references` đã bắt hai lần trước ở chỗ khác: hai bản của một
 * sự thật, giữ khớp nhau bằng trí nhớ.
 *
 * Phạm vi quét là `src/` của mọi workspace, KHÔNG quét `tests/`: một test được
 * phép gõ thẳng `"__disabled__"` để khẳng định giá trị trên DÂY, và bắt nó là biến
 * lint này thành thứ người ta tắt đi (QA B-18).
 *
 * Lint đọc mã ĐÃ BỎ CHÚ THÍCH, không đọc văn bản thô. Bỏ chú thích là phần đắt
 * nhất của file này và nó cần thiết: thiết kế và code đều nhắc hai nhãn này trong
 * chú thích (`flag-api.ts`, `flag-stats.ts`, `stale.classifier.ts`,
 * `stats.ingest.ts`) — và phải được nhắc, vì đó là chỗ giải thích chúng. Một lint
 * grep chuỗi thô sẽ đỏ ở cả bốn chỗ đó, nên nó sẽ phải nới danh sách miễn trừ tới
 * mức không còn canh gì.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");

/**
 * Chỗ DUY NHẤT được khai. Không phải "cả gói `shared-types`": chính chú thích ở
 * `sdk-stats.ts` nói "chỉ được khai ở đây", nên miễn trừ cũng hẹp đúng bằng thế.
 */
const DECLARATION = "packages/shared-types/src/sdk-stats.ts";

interface SourceFile {
  rel: string;
  /** Mã đã bỏ chú thích */
  code: string;
}

/**
 * Bỏ `//` và một khối chú thích, có phân biệt chuỗi.
 *
 * Viết tay chứ không dùng regex: một regex `/\/\/.*$/` sẽ cắt nửa sau của
 * `"https://…"`, và một regex cho khối sẽ ăn mất `"/*"` nằm trong chuỗi. Bộ quét
 * dưới đây đi từng ký tự và luôn biết mình đang ở trong chuỗi nào, nên hai ca đó
 * không xảy ra. Chuỗi được GIỮ NGUYÊN (kể cả dấu mở đóng) vì chính chúng là thứ
 * cần kiểm.
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;

  while (i < text.length) {
    const ch = text[i] as string;

    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        // Ký tự thoát: chép luôn ký tự sau nó, không để nó đóng chuỗi
        if (i + 1 < text.length) out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
        i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === "dist" || entry === "generated")
        continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
        out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** `src/` của mọi workspace dưới `packages/`, `services/`, `apps/` */
function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const group of ["packages", "services", "apps"]) {
    const base = join(ROOT, group);
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      const src = join(base, name, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue; // gói chưa có src (ví dụ chỉ có scripts/)
      }
      for (const path of tsFilesUnder(src)) {
        out.push({
          rel: path.replace(ROOT, "").replace(/\\/g, "/").replace(/^\//, ""),
          code: stripComments(readFileSync(path, "utf8")),
        });
      }
    }
  }
  return out;
}

const files = sourceFiles();

/** Chuỗi xuất hiện dưới dạng LITERAL: trong nháy đơn, nháy kép hoặc backtick */
function literalOf(value: string): RegExp {
  return new RegExp(`["'\`]${value}["'\`]`);
}

describe("INV-23.7 — nhãn stats chỉ được khai ở @udp/shared-types", () => {
  it("quét được src của nhiều gói — nếu không, mọi test dưới rỗng", () => {
    // Chốt chống rỗng: đổi cách xếp workspace mà file này im lặng duyệt danh sách
    // trống thì nó xanh vì không nhìn, không phải vì không có lỗi.
    expect(files.length).toBeGreaterThan(200);
    expect(files.map((f) => f.rel)).toContain(DECLARATION);
  });

  it("bộ bỏ chú thích giữ literal và bỏ chú thích — đo trên file thật", () => {
    /**
     * Phép kiểm này canh chính công cụ đo. Hai file thật, hai chiều:
     * `sdk-stats.ts` PHẢI còn literal sau khi bỏ chú thích (nếu không, test dưới
     * xanh vì bộ quét đã ăn mất mọi thứ), còn `flag-api.ts` nhắc hai nhãn CHỈ
     * trong chú thích nên PHẢI sạch (nếu không, lint sẽ báo động giả ở đó).
     */
    const decl = files.find((f) => f.rel === DECLARATION);
    expect(decl?.code).toMatch(literalOf("__disabled__"));

    const flagApi = files.find(
      (f) => f.rel === "packages/shared-types/src/flag-api.ts",
    );
    expect(flagApi, "không tìm thấy flag-api.ts").toBeDefined();
    expect(
      readFileSync(join(ROOT, "packages/shared-types/src/flag-api.ts"), "utf8"),
    ).toContain("__disabled__");
    expect(flagApi?.code).not.toContain("__disabled__");
  });

  it("bộ bỏ chú thích không cắt chuỗi có // hay /* bên trong", () => {
    // Ca hồi quy cho hai bẫy mà một regex sẽ sập: URL trong chuỗi, và dấu mở khối
    // chú thích nằm trong chuỗi.
    expect(stripComments('const u = "https://a.example/x"; // ghi chú')).toBe(
      'const u = "https://a.example/x"; ',
    );
    expect(stripComments('const s = "/* không phải chú thích */";')).toBe(
      'const s = "/* không phải chú thích */";',
    );
  });

  it("không src nào ngoài sdk-stats.ts khai literal của nhãn stats", async () => {
    // Nguồn giá trị là CHÍNH module đó, không phải hai chuỗi chép tay vào đây:
    // đổi nhãn ở nguồn thì lint này đi theo, không cần ai sửa.
    const { STATS_VARIANT } = await import("@udp/shared-types/sdk-stats");
    const sentinels = Object.values(STATS_VARIANT);
    expect(sentinels.length).toBeGreaterThanOrEqual(2);

    const offenders: string[] = [];
    for (const file of files) {
      if (file.rel === DECLARATION) continue;
      for (const sentinel of sentinels) {
        if (literalOf(sentinel).test(file.code)) {
          offenders.push(
            `${file.rel}: khai literal "${sentinel}" — nhập từ ` +
              `@udp/shared-types/sdk-stats (STATS_VARIANT) thay vì chép chuỗi`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("nhãn stats không bao giờ lọt qua schema key variant", async () => {
    /**
     * Vế còn lại của INV-23.7, và là lý do hai chuỗi này an toàn làm khoá hàng:
     * nếu một flag đặt được variant tên `__disabled__` thì hàng của nó và hàng
     * "flag đang tắt" trộn vào nhau, và §6.7 không còn phân biệt được. Kiểm qua
     * schema CÔNG KHAI của body tạo flag — đúng biên mà một variant thật đi qua —
     * kèm một ĐỐI CHỨNG DƯƠNG: cùng body với key thường thì phải lọt, nếu không
     * thì ca âm ở trên xanh vì lý do khác (thiếu trường, sai `flagType`).
     */
    const { STATS_VARIANT } = await import("@udp/shared-types/sdk-stats");
    // Barrel, không subpath: `flag-api` không có trong `exports` của gói
    const { createFlagFields } = await import("@udp/shared-types");
    const bodyWith = (variantKey: string): unknown => ({
      key: "stats-sentinel-probe",
      flagType: "BOOLEAN",
      variants: [
        { key: variantKey, value: true },
        { key: "off", value: false },
      ],
    });

    expect(createFlagFields.safeParse(bodyWith("on")).success).toBe(true);
    for (const sentinel of Object.values(STATS_VARIANT)) {
      expect(
        createFlagFields.safeParse(bodyWith(sentinel)).success,
        `${sentinel} lại lọt qua schema key variant`,
      ).toBe(false);
    }
  });
});
