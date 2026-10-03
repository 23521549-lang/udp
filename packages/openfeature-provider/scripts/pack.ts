import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * [Plan #62 62a-5] Dựng ARTIFACT PHÁT HÀNH của provider, và khẳng định hợp đồng của nó.
 *
 * Đây là đường đóng gói DUY NHẤT: `tests/package.test.ts` tiêu thụ đúng tarball mà script này sinh ra, và job
 * `build-npm` của `publish.yml` phát hành đúng tarball đó. "Thứ được kiểm" và "thứ được phát hành" là một tệp.
 *
 * Năm bước, và vì sao cần cả năm (mỗi cái trả một phép đo, xem QĐ-3 của spec):
 *
 *   1. `build` — `pnpm pack` KHÔNG kiểm `dist/` có tồn tại: thiếu `dist/` thì nó vẫn exit 0 và cho ra một tarball
 *      ba tệp mà `main` trỏ vào hư không, rồi `npm publish` nhận luôn.
 *   2. `pnpm pack` — và KHÔNG phải `npm pack`: chỉ pnpm áp `publishConfig` (npm thì giữ `main: "./src/index.ts"`,
 *      một đường dẫn không có trong tarball). Lệnh phải là `pnpm -C <dir> pack`; `pnpm --filter … pack` báo
 *      `ERROR  Unknown option: 'recursive'`.
 *   3. Xoá `@udp/*` khỏi `devDependencies` và xoá `scripts`. pnpm KHÔNG xoá `@udp/*` — nó đổi `workspace:*` thành
 *      version cục bộ (`"@udp/config": "0.1.0"`), nên manifest phát hành sẽ trỏ tới sáu gói không tồn tại trên
 *      npm. `publishConfig.devDependencies: {}` không vá được: pnpm 9.12.0 chỉ nâng một tập khoá biết trước.
 *      `scripts` thì bảo người đọc trang gói chạy `tsx scripts/build.ts`, một tệp không có trong tarball.
 *   4. `npm pack` thư mục đã sửa — npm và pnpm có cùng tập "luôn đưa vào" (`LICENSE*`, `README*`, `package.json`),
 *      nên không tệp nào của bước 2 bị mất.
 *   5. Khẳng định hợp đồng. Nó nằm ở ĐÂY chứ không chỉ trong một ô test, vì đây là thứ CHẶN một lượt publish.
 *
 * Bước 3 không phải một nguồn sự thật thứ hai (R8): `publishConfig` vẫn là nơi duy nhất khai hình dạng manifest
 * phát hành, và bước này là một phép xoá theo luật đã khai, kết quả được bước 5 kiểm.
 *
 *   pnpm -C packages/openfeature-provider exec tsx scripts/pack.ts --out <thư mục>
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Tệp được phép nằm ở GỐC tarball; mọi tệp khác phải ở dưới `package/dist/` */
const ROOT_FILES = ["package.json", "LICENSE", "README.md"];

/** Subpath mà bản phát hành xuất — `./testing` CHỈ tồn tại trong monorepo (§6.8) */
const PUBLISHED_EXPORTS = [".", "./metrics"];

const UDP_SCOPE = ["@udp", ""].join("/");

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  main?: string;
  types?: string;
  scripts?: Record<string, string>;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  publishConfig?: Record<string, unknown>;
  repository?: { directory?: string; url?: string };
}

export interface PublishArtifact {
  /** Đường dẫn tuyệt đối tới tarball phát hành */
  tarball: string;
  /** Mọi entry của tarball, như `tar -tzf` in ra */
  entries: string[];
  /** Manifest BÊN TRONG tarball — thứ khách thật sự nhận */
  manifest: Manifest;
}

/**
 * `pnpm` và `npm` trên Windows là `.cmd`: gọi thẳng (không shell) là ENOENT/EINVAL. Khi script chạy dưới pnpm thì
 * `npm_execpath` trỏ tới bản JS của nó — dùng bản đó là cách chạy không qua shell, nên không phải lo trích dẫn.
 */
function pnpm(args: string[], cwd: string): void {
  const execPath = process.env["npm_execpath"];
  if (execPath !== undefined && execPath.endsWith(".cjs")) {
    execFileSync(process.execPath, [execPath, ...args], { cwd, stdio: "pipe" });
    return;
  }
  execFileSync("pnpm", args, { cwd, shell: true, stdio: "pipe" });
}

function npm(args: string[], cwd: string): void {
  execFileSync("npm", args, { cwd, shell: true, stdio: "pipe" });
}

/**
 * `tar` của Windows đọc `C:\…` như một host từ xa (`Cannot connect to C: resolve failed`), nên tên tệp LUÔN đi
 * tương đối cùng một `cwd`.
 */
function tar(args: string[], cwd: string): string {
  return execFileSync("tar", args, { cwd, encoding: "utf8" });
}

function tarballIn(dir: string): string {
  const found = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (found === undefined) throw new Error(`không có .tgz nào trong ${dir}`);
  return join(dir, found);
}

function entriesOf(tarball: string): string[] {
  return tar(["-tzf", basename(tarball)], dirname(tarball))
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\/$/, ""));
}

function manifestIn(tarball: string): Manifest {
  const raw = tar(
    ["-xzOf", basename(tarball), "package/package.json"],
    dirname(tarball),
  );
  return JSON.parse(raw) as Manifest;
}

/**
 * Hợp đồng của artifact phát hành (AC-1, AC-7). Gom MỌI vi phạm rồi ném một lần: một lượt publish hỏng vì ba lý do
 * thì người sửa muốn thấy cả ba, không phải sửa một rồi chạy lại để thấy cái sau.
 */
export function assertPublishArtifact(
  entries: string[],
  manifest: Manifest,
): void {
  const bad: string[] = [];

  const outside = entries.filter((e) => !e.startsWith("package/"));
  if (outside.length > 0)
    bad.push(`entry ngoài package/: ${outside.join(", ")}`);
  const inner = entries
    .filter((e) => e.startsWith("package/"))
    .map((e) => e.slice("package/".length))
    .filter((e) => e.length > 0);
  const atRoot = inner.filter((e) => !e.includes("/"));
  const unexpected = atRoot.filter((e) => !ROOT_FILES.includes(e));
  if (unexpected.length > 0) {
    bad.push(`tệp lạ ở gốc tarball: ${unexpected.join(", ")}`);
  }
  const elsewhere = inner.filter(
    (e) => e.includes("/") && !e.startsWith("dist/"),
  );
  if (elsewhere.length > 0) {
    bad.push(`tệp ngoài dist/: ${elsewhere.join(", ")}`);
  }
  for (const required of ["LICENSE", "README.md", "dist/THIRD_PARTY_NOTICES"]) {
    if (!inner.includes(required)) bad.push(`thiếu ${required}`);
  }
  const junk = inner.filter(
    (e) => e.endsWith(".map") || e.endsWith(".tsbuildinfo"),
  );
  if (junk.length > 0) bad.push(`rác của build: ${junk.join(", ")}`);

  if (manifest.private === true) bad.push("manifest còn `private: true`");
  if (manifest.publishConfig !== undefined) {
    bad.push("manifest còn `publishConfig` (pnpm phải áp và xoá nó)");
  }
  if (manifest.scripts !== undefined) bad.push("manifest còn `scripts`");
  if (manifest.license === undefined) bad.push("manifest thiếu `license`");
  if (manifest.repository?.directory === undefined) {
    bad.push("manifest thiếu `repository.directory`");
  }
  const udp = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ].filter((d) => d.startsWith(UDP_SCOPE));
  if (udp.length > 0) {
    bad.push(`manifest còn trỏ tới gói nội bộ: ${udp.join(", ")}`);
  }
  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    bad.push("`dependencies` phải RỖNG (lõi đánh giá góp vào bundle)");
  }
  for (const [field, value] of [
    ["main", manifest.main],
    ["types", manifest.types],
  ] as const) {
    if (value === undefined || !value.startsWith("./dist/")) {
      bad.push(`\`${field}\` phải trỏ ./dist/, đang là ${String(value)}`);
    }
  }
  const exported = Object.keys(manifest.exports ?? {}).sort();
  if (exported.join("|") !== PUBLISHED_EXPORTS.join("|")) {
    bad.push(
      `\`exports\` phải đúng ${PUBLISHED_EXPORTS.join(", ")}, đang là ${exported.join(", ")}`,
    );
  }

  if (bad.length > 0) {
    throw new Error(
      `artifact phát hành không đạt hợp đồng:\n  - ${bad.join("\n  - ")}`,
    );
  }
}

export function packPublishArtifact(options: {
  out: string;
  /** `false` khi người gọi vừa build xong — mặc định build, vì pack trên `dist/` cũ không ai thấy */
  build?: boolean;
}): PublishArtifact {
  const { out } = options;
  if (options.build !== false) {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/build.ts"], {
      cwd: root,
      stdio: "inherit",
    });
  }

  const stage = join(out, ".stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  pnpm(["pack", "--pack-destination", stage], root);
  const staged = tarballIn(stage);
  tar(["-xzf", basename(staged)], stage);
  const unpacked = join(stage, "package");
  if (!existsSync(unpacked)) {
    throw new Error(`giải nén ${staged} không ra thư mục package/`);
  }

  const manifestPath = join(unpacked, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  delete manifest.scripts;
  for (const key of Object.keys(manifest.devDependencies ?? {})) {
    if (key.startsWith(UDP_SCOPE)) delete manifest.devDependencies?.[key];
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  npm(["pack", "--pack-destination", out], unpacked);
  const tarball = tarballIn(out);
  const entries = entriesOf(tarball);
  const packed = manifestIn(tarball);
  assertPublishArtifact(entries, packed);
  rmSync(stage, { recursive: true, force: true });
  return { tarball, entries, manifest: packed };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const flag = process.argv.indexOf("--out");
  const dir = flag === -1 ? undefined : process.argv[flag + 1];
  if (dir === undefined) {
    throw new Error("thiếu --out <thư mục>");
  }
  mkdirSync(dir, { recursive: true });
  const artifact = packPublishArtifact({ out: resolve(dir) });
  process.stdout.write(`${artifact.tarball}\n`);
}
