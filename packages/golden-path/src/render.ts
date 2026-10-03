import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sinh cây tệp Golden Path (§11.1) cho một project — Plan #48 QĐ-1, QĐ-2.
 *
 * Template là dự án THẬT dưới `templates/` (Node typecheck, lint và test trong monorepo; Python qua
 * ruff, mypy và pytest ở job CI `python`), không phải chuỗi văn bản không ai chạy. Mã template đọc
 * cấu hình từ biến môi trường nên không mang dấu hiệu nào; chỉ bốn chỗ được thay khi sinh:
 *
 *  - `golden-path-app` ⇒ slug của project (tên package, workload, container, `OTEL_SERVICE_NAME`,
 *    secret `<slug>-udp`) — slug là thứ job deploy tìm để đổi image (§8.3);
 *  - `REGISTRY_REF` ⇒ registry của binding `registry.oci` (giữ nguyên khi project chưa có);
 *  - phiên bản `workspace:*` của provider ⇒ phiên bản phát hành;
 *  - **tên gói** provider ⇒ tên PHÁT HÀNH (`PROVIDER_PUBLIC_NAME`): template giữ tên trong kho để còn
 *    chạy được trong monorepo, chỉ cây sinh cho khách mang tên công khai (§6.8).
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

/** Phiên bản phát hành mà `package.json` sinh ra trỏ tới */
export const PROVIDER_RELEASE = "^0.1.0";

/**
 * [Plan #62 62d-4] Tên PHÁT HÀNH của provider trên npm — cây sinh cho khách dùng tên này.
 *
 * Template giữ tên TRONG KHO để nó còn chạy được trong monorepo (`template-provider.test.ts` nhập thẳng
 * `templates/node/src/app.js` qua workspace), nên phép thay là thứ duy nhất đứng giữa hai thế giới. Nguồn sự thật
 * của giá trị này là `publishConfig.name` của `packages/openfeature-provider/package.json`; một ô của
 * `package-boundaries.test.ts` giữ hai chỗ không trôi khỏi nhau.
 */
export const PROVIDER_PUBLIC_NAME = "udp-openfeature";

/** Ghép qua hằng: một literal `@udp/…` ở đây sẽ bị luật ranh giới đọc như một phụ thuộc thật của package này */
const PROVIDER_IN_REPO = ["@udp", "openfeature-provider"].join("/");

/**
 * Subpath mà BẢN PHÁT HÀNH xuất — cùng tập với `PUBLISHED_EXPORTS` của
 * `packages/openfeature-provider/scripts/pack.ts`. `./testing` tồn tại trong kho và **cố ý không** phát hành.
 */
const PUBLIC_SUBPATHS = new Set(["", "/metrics"]);

/**
 * Khớp specifier TRỌN, không khớp chuỗi con: `(?=["'`\s;)])` chặn `@udp/openfeature-provider-react` bị nuốt thành
 * `udp-openfeature-react` (một gói không tồn tại ⇒ `ERR_MODULE_NOT_FOUND` ở phía khách).
 */
const PROVIDER_SPECIFIER = new RegExp(
  `${PROVIDER_IN_REPO.replace("/", "\\/")}((?:\\/[a-z-]+)*)(?=["'\`\\s;)])`,
  "g",
);

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

/**
 * Đổi tên gói trong kho sang tên phát hành. FAIL-CLOSED ở hai chiều:
 *
 *  - subpath ngoài tập đã phát hành ⇒ **ném**, kèm tên tệp. Không có nó, một ngày ai đó dùng
 *    `…/testing` trong template (tệp dễ cần nó nhất là `tests/app.test.ts`) thì cây sinh ra vỡ ở phía khách với
 *    `ERR_PACKAGE_PATH_NOT_EXPORTED`, mà ô "cây sinh ra không còn `@udp/`" vẫn XANH;
 *  - số lần thay được ĐẾM, và `goldenPathFiles` đòi `> 0` cho runtime `nodejs` — "0 lần thay" không được lẫn với
 *    "không có gì cần thay" (template đổi cách viết import, hay ai đó ghép chuỗi qua biến).
 */
function toPublicName(
  text: string,
  path: string,
): { out: string; hits: number } {
  let hits = 0;
  const out = text.replace(PROVIDER_SPECIFIER, (_match, subpath: string) => {
    hits += 1;
    if (!PUBLIC_SUBPATHS.has(subpath)) {
      throw new Error(
        `${path}: template dùng subpath "${subpath}" của provider, mà bản phát hành không xuất nó ` +
          `(xem PUBLISHED_EXPORTS của packages/openfeature-provider/scripts/pack.ts). ` +
          `Cây sinh ra sẽ ERR_PACKAGE_PATH_NOT_EXPORTED ở phía khách.`,
      );
    }
    return PROVIDER_PUBLIC_NAME + subpath;
  });
  return { out, hits };
}

function render(
  text: string,
  path: string,
  input: GoldenPathInput,
): { content: string; hits: number } {
  const named = text
    .replaceAll(APP_TOKEN, input.slug)
    .replaceAll('"workspace:*"', `"${PROVIDER_RELEASE}"`);
  const withRegistry =
    input.registryRef === null
      ? named
      : named.replaceAll(REGISTRY_TOKEN, input.registryRef);
  const { out, hits } = toPublicName(withRegistry, path);
  return { content: out, hits };
}

/** Cây tệp Golden Path của một project, sắp theo đường dẫn */
export function goldenPathFiles(input: GoldenPathInput): GoldenPathFile[] {
  let hits = 0;
  const files = SOURCES[input.runtime]
    .flatMap((dir) => walk(join(TEMPLATE_ROOT, dir), ""))
    .map(({ abs, rel }) => {
      const path = rel.replace(/\.tmpl$/, "");
      const rendered = render(readFileSync(abs, "utf8"), path, input);
      hits += rendered.hits;
      return { path, content: rendered.content };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (input.runtime === "nodejs" && hits === 0) {
    throw new Error(
      "không tệp template Node nào nhắc tên provider trong kho: phép đổi sang tên phát hành " +
        "không còn tác dụng — cây sinh ra sẽ không cài được provider",
    );
  }
  return files;
}
