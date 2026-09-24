import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readDesignDoc } from "../src/design-doc.js";

/**
 * [v4.10] Cổng P22 — sổ nợ kiểm chứng là MỘT danh sách, đối chiếu ở BA nơi.
 *
 * Một món nợ được nhắc trong chú thích mã nguồn ("sổ nợ: `I31-localstack`") hoặc trong
 * §16 của tài liệu mà không có mục trong sổ là một lời hứa không có địa chỉ: người đọc
 * thấy hệ thống thừa nhận một giới hạn, nhưng không có chỗ nào nói phải làm gì để trả
 * nợ đó, cần hạ tầng gì, và dấu hiệu nào là đạt. Đó chính là kiểu ghi nhận mà một sổ nợ
 * tồn tại để chống.
 *
 * Nên chốt này đối chiếu ba nơi, theo một chiều duy nhất:
 *
 * | Nơi | Vai |
 * | --- | --- |
 * | `docs/measurements/kiem-chung-con-no.md` | **Nguồn sự thật** — mỗi mục là một mục `## <mã>` với sáu trường |
 * | `docs/UDP_design.md` §16 | Trích mã nợ bằng `Sổ nợ: ...` khi một giới hạn có địa chỉ để trả |
 * | Chú thích trong mã nguồn | Trích mã nợ cùng dạng, ngay tại chỗ hiện thực bị thu hẹp |
 *
 * Chiều là **hai nơi sau ⊆ nơi đầu**. Không kiểm chiều ngược: một món nợ thuần phép đo
 * (`E3-quiet`) không có chỗ nào trong mã để mà nhắc, và bắt nó phải xuất hiện trong mã
 * sẽ sinh ra những chú thích viết chỉ để làm test xanh.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const LEDGER = resolve(ROOT, "docs/measurements/kiem-chung-con-no.md");

/** Năm trường mà MỖI mục phải có, kể tên chính xác */
const REQUIRED_FIELDS = [
  /** Có mục viết "Vì sao VẪN nợ" (đã đo một lần nhưng chưa ở hình học chính thức) */
  "**Vì sao",
  "**Tiền đề",
  "**Đạt:**",
  "**Tài nguyên:**",
  "**Ảnh hưởng tới kết luận:**",
] as const;

/**
 * Trường thứ SÁU — "chạy nó thế nào" — có ba tên, và mỗi mục phải có đúng một.
 *
 * Ba tên chứ không một, vì "chạy nó" nghĩa khác nhau theo loại nợ: phần lớn mục là một
 * lệnh; `E5` là một **runbook** bốn bước với ba service và hai instance app, nên nén nó
 * vào một dòng `Lệnh:` là nói dối về công sức; `E14-prometheus` không chạy lệnh nào mà
 * **đọc** bốn metric của Prometheus sau một giờ. Danh sách này là tường minh và đóng:
 * một tên thứ tư phải được thêm vào đây, tức nó là một quyết định nhìn thấy được, chứ
 * không phải một mục lặng lẽ thiếu trường.
 */
const HOW_TO_RUN = ["**Lệnh:**", "**Runbook", "**Đo:**"] as const;

interface LedgerItem {
  code: string;
  body: string;
}

function ledger(): { text: string; items: LedgerItem[] } {
  const text = readFileSync(LEDGER, "utf8");
  const items = text
    .split("\n## ")
    .slice(1)
    .map((part) => ({
      code: (part.split(/[\s—]/)[0] ?? "").trim(),
      body: part,
    }));
  return { text, items };
}

/**
 * Mã nợ trích từ một đoạn văn bản, theo đúng một dạng: `Sổ nợ: ` rồi các mã trong nháy.
 *
 * Quét mọi chuỗi trong nháy ngược của cả tệp là quét sai: `design-lint`, `pg-boss`,
 * `udp-traffic` đều cùng hình dạng với một mã nợ, và một phép kiểm báo chúng thiếu trong
 * sổ là một phép kiểm không ai giữ được. Nên dạng trích phải là một QUY ƯỚC tường minh.
 */
function debtCodesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /S[ổo] n[ợo]: ((?:`[A-Za-z0-9][A-Za-z0-9-]*`(?:, )?)+)/g,
  )) {
    for (const code of (m[1] ?? "").matchAll(/`([A-Za-z0-9][A-Za-z0-9-]*)`/g)) {
      if (code[1] !== undefined) out.add(code[1]);
    }
  }
  return [...out].sort();
}

/**
 * [v4.11] Quét cả `.tsx`.
 *
 * Chiều kiểm của tệp này là "mã ⊆ sổ", nên một `Sổ nợ: \`ma-viet-sai\`` nằm trong một
 * tệp `.tsx` sẽ **im lặng** thay vì đỏ nếu glob chỉ bắt `.ts`. Mở trước khi có tệp `.tsx`
 * đầu tiên: một chốt chỉ sẵn sàng khi nó được mở trước lúc cần.
 */
function sourceFiles(): string[] {
  return ["packages", "services", "apps"].flatMap((dir) =>
    globSync("*/src/**/*.{ts,tsx}", { cwd: resolve(ROOT, dir) })
      .concat(globSync("*/tests/**/*.{ts,tsx}", { cwd: resolve(ROOT, dir) }))
      .concat(globSync("*/scripts/**/*.{ts,tsx}", { cwd: resolve(ROOT, dir) }))
      .map((p) => resolve(ROOT, dir, p)),
  );
}

describe("sổ nợ kiểm chứng — hình dạng", () => {
  it("mỗi mục có đủ SÁU trường", () => {
    const { items } = ledger();
    const broken = items.flatMap((item) =>
      REQUIRED_FIELDS.filter((f) => !item.body.includes(f)).map(
        (f) => `${item.code} thiếu ${f}`,
      ),
    );
    expect(broken).toEqual([]);
  });

  it("mỗi mục nói cách chạy, bằng đúng một trong ba tên", () => {
    const { items } = ledger();
    const bad = items
      .map((item) => ({
        code: item.code,
        found: HOW_TO_RUN.filter((f) => item.body.includes(f)),
      }))
      .filter((x) => x.found.length !== 1)
      .map((x) => `${x.code}: ${String(x.found.length)} tên`);
    expect(bad).toEqual([]);
  });

  /**
   * Con số trong tiêu đề khớp số mục đếm được.
   *
   * Viết con số ra là điều kiện để nó kiểm được: một sổ nợ chỉ nói "có vài mục" thì thêm
   * hay bớt một mục không ai thấy, và báo cáo tiến độ ("đã đo thật bao nhiêu, còn nợ bao
   * nhiêu") mất một trong hai vế.
   */
  it("số mục khai trong tiêu đề khớp số mục thật", () => {
    const { text, items } = ledger();
    const declared = /Số mục hiện tại: (\d+)/.exec(text)?.[1];
    expect(declared, "tiêu đề phải khai số mục").toBeDefined();
    expect(items).toHaveLength(Number(declared));
  });

  /**
   * [v4.10] AC-9.5 thành một phép kiểm, không phải một câu đọc bằng mắt.
   *
   * Acceptance criterion AC-9.5 của Plan #24 kể tên MƯỜI MỘT mã nợ và đòi "mỗi mục nêu
   * lệnh sẽ chạy và điều kiện hạ tầng cần". Phần "nêu lệnh và điều kiện" đã được hai ô
   * trên canh cho mọi mục; phần "đủ mười một mã" thì cần chính danh sách đó, nên nó nằm
   * ở đây.
   *
   * Bốn mã của sổ từng mang tên khác (`I31-aws-eks`, `cluster-access-real`,
   * `I24-token-that`, `I25-audit`) - tên riêng của người viết sổ, không phải tên trong
   * AC. Đã đổi về tên của AC ở P23: một tiêu chí nghiệm thu mà phải đọc bằng mắt để đối
   * chiếu tên là một tiêu chí sẽ trôi.
   */
  it("đủ mười một mã nợ mà AC-9.5 kể tên", () => {
    const required = [
      "I31-localstack",
      "I31-aws",
      "I32-cluster",
      "E15",
      "E16",
      "helm-real",
      "clusteraccess-direct",
      "I24-cluster",
      "I25-cluster",
      "cred-federation",
      "agent-mode",
    ];
    const known = new Set(ledger().items.map((i) => i.code));
    expect(required.filter((c) => !known.has(c))).toEqual([]);
  });

  it("không mã nợ nào bị khai hai lần", () => {
    const codes = ledger().items.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("sổ nợ kiểm chứng — ba nơi nói cùng một danh sách", () => {
  it("mọi mã nợ §16 của tài liệu có mục trong sổ", () => {
    const cited = debtCodesIn(readDesignDoc().join("\n"));
    const known = new Set(ledger().items.map((i) => i.code));
    expect(cited.length, "tài liệu phải trích ít nhất một mã").toBeGreaterThan(
      0,
    );
    expect(cited.filter((c) => !known.has(c))).toEqual([]);
  });

  it("mọi mã nợ nhắc trong mã nguồn có mục trong sổ", () => {
    const known = new Set(ledger().items.map((i) => i.code));
    const orphans: string[] = [];
    for (const file of sourceFiles()) {
      for (const code of debtCodesIn(readFileSync(file, "utf8"))) {
        if (!known.has(code)) {
          orphans.push(`${file.slice(ROOT.length + 1)}: ${code}`);
        }
      }
    }
    expect(
      orphans,
      "mã nợ nhắc trong mã mà không có mục trong sổ là một lời hứa không địa chỉ",
    ).toEqual([]);
  });
});
