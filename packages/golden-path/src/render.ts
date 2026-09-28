import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sinh cây tệp Golden Path (§11.1) cho một project — Plan #48 QĐ-1, QĐ-2.
 *
 * Template là dự án THẬT dưới `templates/` (Node typecheck, lint và test trong monorepo; Python qua
 * ruff, mypy và pytest ở job CI `python`), không phải chuỗi văn bản không ai chạy. Mã template đọc
 * cấu hình từ biến môi trường nên không mang dấu hiệu nào; chỉ ba chỗ được thay khi sinh:
 *
 *  - `golden-path-app` ⇒ slug của project (tên package, workload, container, `OTEL_SERVICE_NAME`,
 *    secret `<slug>-udp`) — slug là thứ job deploy tìm để đổi image (§8.3);
 *  - `REGISTRY_REF` ⇒ registry của binding `registry.oci` (giữ nguyên khi project chưa có);
 *  - phiên bản `workspace:*` của provider ⇒ phiên bản phát hành.
 *
 * Tệp mà công cụ của monorepo sẽ hiểu nhầm (`package.json`, `tsconfig.json`) mang đuôi `.tmpl`.
 */

export const GOLDEN_PATH_RUNTIMES = ["nodejs", "python"] as const;
export type GoldenPathRuntime = (typeof GOLDEN_PATH_RUNTIMES)[number];

export interface GoldenPathFile {
  /** Đường dẫn trong repo sinh ra, dạng posix */
  path: string;
  content: string;
}

export interface GoldenPathInput {
  runtime: GoldenPathRuntime;
  /** `workloadSlugFor(project.name)` */
  slug: string;
  /** Endpoint của binding `registry.oci`; `null` ⇒ giữ dấu `REGISTRY_REF` cho developer điền */
  registryRef: string | null;
}

/** Dấu hiệu trong template — cũng là thứ test khẳng định không còn sau khi sinh */
export const APP_TOKEN = "golden-path-app";
export const REGISTRY_TOKEN = "REGISTRY_REF";

/** Phiên bản phát hành của `@udp/openfeature-provider` mà `package.json` sinh ra trỏ tới */
export const PROVIDER_RELEASE = "^0.1.0";

const TEMPLATE_ROOT = fileURLToPath(new URL("../templates/", import.meta.url));

/** Thư mục template theo runtime — `common` là phần giống nhau (manifest Kubernetes) */
const SOURCES: Record<GoldenPathRuntime, readonly string[]> = {
  nodejs: ["node", "common"],
  python: ["python", "common"],
};

/** Rác do chạy test template tại chỗ — không bao giờ thuộc cây sinh ra */
const IGNORED = new Set([
  "node_modules",
  "dist",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".venv",
]);

export function isGoldenPathRuntime(
  runtime: string,
): runtime is GoldenPathRuntime {
  return (GOLDEN_PATH_RUNTIMES as readonly string[]).includes(runtime);
}

function walk(dir: string, prefix: string): { abs: string; rel: string }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !IGNORED.has(e.name))
    .flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name), `${prefix}${e.name}/`)
        : [{ abs: join(dir, e.name), rel: `${prefix}${e.name}` }],
    );
}

function render(text: string, input: GoldenPathInput): string {
  const named = text
    .replaceAll(APP_TOKEN, input.slug)
    .replaceAll('"workspace:*"', `"${PROVIDER_RELEASE}"`);
  return input.registryRef === null
    ? named
    : named.replaceAll(REGISTRY_TOKEN, input.registryRef);
}

/** Cây tệp Golden Path của một project, sắp theo đường dẫn */
export function goldenPathFiles(input: GoldenPathInput): GoldenPathFile[] {
  return SOURCES[input.runtime]
    .flatMap((dir) => walk(join(TEMPLATE_ROOT, dir), ""))
    .map(({ abs, rel }) => ({
      path: rel.replace(/\.tmpl$/, ""),
      content: render(readFileSync(abs, "utf8"), input),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
