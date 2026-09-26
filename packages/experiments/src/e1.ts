/**
 * **E1** (§14.1) [Plan #42] — effort mở rộng adapter, đo từ LỊCH SỬ GIT chứ không từ trí nhớ.
 * Phần thuần ở đây (phân loại tệp, đọc bề mặt interface từ mã nguồn) để test được; script
 * `scripts/e1.ts` gọi git và ghép số.
 *
 * Ba câu hỏi của §14.1: bao nhiêu file phải sửa NGOÀI thư mục adapter khi thêm một tool; bao nhiêu
 * lần phá vỡ interface sau tag `adapter-interface-v1`; bao nhiêu lần nới lỏng bộ contract test.
 */

/** Nhóm của một tệp đổi trong commit thêm tool — thứ tác giả adapter phải chạm hay không */
export type FileKind =
  | "adapter"
  | "adapter-base"
  | "adapter-core"
  | "catalog"
  | "schema"
  | "test"
  | "docs"
  | "product";

export const FILE_KINDS: readonly FileKind[] = [
  "adapter",
  "adapter-base",
  "adapter-core",
  "catalog",
  "schema",
  "test",
  "docs",
  "product",
];

/** Nhóm tính là "ngoài thư mục adapter" theo nghĩa của §14.1 — không test, không tài liệu */
export const OUTSIDE_ADAPTERS: readonly FileKind[] = [
  "adapter-base",
  "adapter-core",
  "catalog",
  "schema",
  "product",
];

const ADAPTER_DIR = /^services\/core-backend\/src\/modules\/[a-z-]+-adapter\//;
const TOOL_DIR =
  /^(services\/core-backend\/src\/modules\/[a-z-]+-adapter\/[a-z0-9-]+)\/index\.ts$/;

export function kindOf(path: string): FileKind {
  if (path.startsWith("docs/") || path.endsWith(".md")) return "docs";
  if (
    /(^|\/)tests?\//.test(path) ||
    /\.test\.tsx?$/.test(path) ||
    path.includes("/fixtures/")
  ) {
    return "test";
  }
  if (ADAPTER_DIR.test(path)) return "adapter";
  if (path.startsWith("services/core-backend/src/modules/adapter-base/")) {
    return "adapter-base";
  }
  if (path.startsWith("packages/adapter-core/")) return "adapter-core";
  if (path === "packages/config/src/domains.ts") return "catalog";
  if (path.startsWith("packages/db/prisma/")) return "schema";
  return "product";
}

/** Thư mục tool từ đường dẫn `index.ts` của nó, hoặc `null` */
export function toolDirOf(indexPath: string): string | null {
  return TOOL_DIR.exec(indexPath)?.[1] ?? null;
}

/** Đếm theo nhóm — mọi nhóm có mặt, kể cả 0, để tổng cộng đủ số tệp */
export function countByKind(
  paths: readonly string[],
): Record<FileKind, number> {
  const out = Object.fromEntries(FILE_KINDS.map((k) => [k, 0])) as Record<
    FileKind,
    number
  >;
  for (const p of paths) out[kindOf(p)] += 1;
  return out;
}

/** Tên trong `export const NAME: readonly string[] = [ "a", "b" ];` của mã nguồn */
export function listConst(source: string, name: string): string[] {
  const m = new RegExp(
    `export const ${name}: readonly string\\[\\] = \\[([^\\]]*)\\]`,
  ).exec(source);
  if (m === null) return [];
  return [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? "");
}

/**
 * Thành viên TRỰC TIẾP (một mức thụt lề) của `export interface NAME … { … }` — tên phương thức và
 * thuộc tính, bỏ chú thích và thân kiểu lồng.
 */
export function interfaceMembers(source: string, name: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    new RegExp(`^export interface ${name}\\b`).test(l),
  );
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("}")) break;
    const m = /^ {2}(?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\??\s*[:(]/.exec(
      line,
    );
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

export interface SurfaceDiff {
  added: string[];
  removed: string[];
}

export function diffNames(
  before: readonly string[],
  after: readonly string[],
): SurfaceDiff {
  return {
    added: after.filter((n) => !before.includes(n)),
    removed: before.filter((n) => !after.includes(n)),
  };
}
