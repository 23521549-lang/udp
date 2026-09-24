import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Ba luật của DESIGN.md mà mắt người sẽ bỏ sót ở màn hình thứ mười, thành phép kiểm máy:
 *
 * 1. **Không em-dash trong chữ giao diện** (DESIGN.md §9). Chỉ xét chuỗi và chữ JSX —
 *    chú thích mã được phép, vì chúng không lên màn hình. Đọc bằng trình phân tích của
 *    TypeScript chứ không bằng regex: regex không phân biệt được chú thích với chuỗi.
 * 2. **Chỉ Lucide** (DESIGN.md §5): không import bộ icon khác, và `<svg>` tự vẽ chỉ ở
 *    những tệp đã khai (logo, vòng tiến độ, sparkline, biểu đồ).
 * 3. **Màu chỉ qua token**: không hex/rgb/hsl/oklch thô trong CSS của Portal hay trong mã
 *    — màu thô là cách chế độ tối lặng lẽ vỡ.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return walk(full, ext);
    return ext.test(e) ? [full] : [];
  });
}

const codeFiles = walk(SRC, /\.(ts|tsx)$/);
const tsxFiles = codeFiles.filter((f) => f.endsWith(".tsx"));

/** Mọi đoạn chữ có thể lên màn hình: string literal, template, và chữ JSX */
function visibleTexts(file: string): { text: string; line: number }[] {
  const src = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: { text: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isJsxText(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push({
        text: node.text,
        line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

describe("lint thiết kế của Portal", () => {
  it("quét được mã thật — không phải 0 tệp", () => {
    expect(tsxFiles.length).toBeGreaterThan(15);
  });

  it("không em-dash (—) trong chữ giao diện", () => {
    const offenders = codeFiles.flatMap((f) =>
      visibleTexts(f)
        .filter((t) => t.text.includes("—"))
        .map((t) => `${relative(SRC, f)}:${String(t.line)}`),
    );
    expect(offenders).toEqual([]);
  });

  it("đối chứng: bộ đọc chữ THẤY em-dash trong chuỗi và bỏ qua chú thích", () => {
    const probe = join(here, "fixtures", "emdash-probe.tsx");
    const texts = visibleTexts(probe).map((t) => t.text);
    expect(texts.some((t) => t.includes("—"))).toBe(true);
    expect(texts.some((t) => t.includes("chú thích"))).toBe(false);
  });

  it("chỉ import icon từ lucide-react", () => {
    const banned =
      /from\s+"(react-icons|@heroicons|@radix-ui\/react-icons|@tabler\/icons|react-feather|@phosphor-icons)/;
    const offenders = codeFiles
      .filter((f) => banned.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("<svg> tự vẽ chỉ ở những tệp đã khai", () => {
    const allowed = new Set([
      join("components", "Logo.tsx"),
      join("components", "ProgressRing.tsx"),
      join("features", "flag", "FlagsPage.tsx"),
      join("features", "rollout", "RolloutDetailPage.tsx"),
    ]);
    const offenders = tsxFiles
      .map((f) => relative(SRC, f))
      .filter((f) => !allowed.has(f))
      .filter((f) => /<svg[\s>]/.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("không màu thô trong mã Portal (chỉ var(--token))", () => {
    const raw = /#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch)\(/;
    const offenders = codeFiles.flatMap((f) =>
      visibleTexts(f)
        .filter((t) => raw.test(t.text))
        .map(
          (t) =>
            `${relative(SRC, f)}:${String(t.line)}: ${t.text.slice(0, 40)}`,
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("portal.css chỉ dùng token màu, không màu thô", () => {
    const css = readFileSync(join(SRC, "styles", "portal.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(
      css.match(/#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch)\(/g) ?? [],
    ).toEqual([]);
  });

  it("prototype.css là bản chép NGUYÊN VĂN của bản mẫu đã duyệt", () => {
    const html = readFileSync(
      join(here, "..", "..", "..", "docs", "design", "portal-prototype.html"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const original = html
      .slice(html.indexOf("<style>") + 7, html.indexOf("</style>"))
      .trim();
    const copy = readFileSync(join(SRC, "styles", "prototype.css"), "utf8");
    expect(copy.replace(/^\/\*[\s\S]*?\*\/\n/, "").trim()).toBe(original);
  });
});
