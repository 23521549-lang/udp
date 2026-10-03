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

/** Tên công khai hợp lệ: không scope, chữ thường — npm `validate-npm-package-name` nhận */
const PUBLIC_NAME = /^[a-z][a-z0-9-]*$/;

/** Tệp trong tarball mà khách THẬT SỰ đọc: mã chạy, kiểu IDE hiện khi hover, và trang gói */
const CUSTOMER_READS = /\.(?:js|d\.ts|md)$/;

/**
 * [Plan #62 62d-1] Áp tên công khai lên manifest đã đóng gói — **không** dựa vào phiên bản pnpm.
 *
 * pnpm 9.12.0 (bản `packageManager` ghim) **KHÔNG** nâng `publishConfig.name`: đo trên chính gói này, tarball ra
 * `udp-openfeature-provider-0.1.0.tgz` với `name = "@udp/openfeature-provider"` và `publishConfig` còn nguyên.
 * Việc nâng `name` chỉ xuất hiện giữa pnpm 11.16 và 11.22. Một phép đo trước đó kết luận ngược là vì nó chạy ở
 * thư mục ngoài repo, nơi `pnpm` là bản toàn cục 11.22.0 — và `pnpm -C <dir>` cũng phân giải `packageManager`
 * theo thư mục ĐÍCH, nên "sửa" bằng `-C` vẫn đo nhầm bản.
 *
 * Nên bước này nhận CẢ HAI thế giới, và ném ở mọi thứ còn lại:
 *   - pnpm chưa nâng ⇒ `publishConfig` còn, và sau khi pnpm đã tiêu thụ `main`/`types`/`exports` thì khoá còn lại
 *     phải ĐÚNG `["name"]`. Còn khoá khác nghĩa là pnpm thôi nâng một khoá hình dạng — một thoái cấp im lặng mà
 *     `main`/`types` trỏ `./dist/` ở hợp đồng sẽ bắt, nhưng bắt ở đây thì thông điệp nói đúng nguyên nhân.
 *   - pnpm đã nâng ⇒ `publishConfig` mất, và `name` phải ĐÃ bằng tên công khai.
 */
function applyPublicName(manifest: Manifest, publicName: string): void {
  const config = manifest.publishConfig;
  if (config === undefined) {
    if (manifest.name !== publicName) {
      throw new Error(
        `pnpm đã xoá publishConfig nhưng tên là ${String(manifest.name)}, phải là ${publicName}`,
      );
    }
    return;
  }
  const left = Object.keys(config).sort().join("|");
  if (left !== "name") {
    throw new Error(
      `pnpm để lại khoá ngoài \`name\` trong publishConfig: ${left} — nó đã thôi nâng khoá hình dạng`,
    );
  }
  manifest.name = publicName;
  delete manifest.publishConfig;
}

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

/** Nội dung một tệp trong tarball — tên tệp đi tương đối cùng `cwd`, xem `tar()` */
function textOf(tarball: string, entry: string): string {
  return tar(["-xzOf", basename(tarball), entry], dirname(tarball));
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
  expectedName: string,
  tarball: string,
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

  /**
   * Tên công khai, và KHÔNG byte nào còn `@udp/`.
   *
   * Phép quét thứ hai là cổng mạnh nhất của đợt này: nó bắt cùng lúc banner của esbuild, JSDoc lọt vào
   * `dist/types/*.d.ts` (thứ IDE của khách hiện khi hover) và trang gói — mà không phải đoán trước một danh sách
   * tệp. Đặt trên TARBALL chứ không trên mã nguồn, vì tarball là chỗ duy nhất phát biểu đúng mệnh đề "thứ khách
   * nhận": `@udp/*` là namespace TRONG KHO, không gói nào của nó cài được từ registry nào.
   */
  if (manifest.name !== expectedName) {
    bad.push(
      `tên đã đóng gói là ${String(manifest.name)}, phải là ${expectedName}`,
    );
  }
  if (!PUBLIC_NAME.test(manifest.name ?? "")) {
    bad.push(`tên đã đóng gói phải không scope: ${String(manifest.name)}`);
  }
  for (const entry of inner.filter((e) => CUSTOMER_READS.test(e))) {
    if (textOf(tarball, `package/${entry}`).includes(UDP_SCOPE)) {
      bad.push(`${entry} còn nhắc ${UDP_SCOPE} — khách không phân giải được`);
    }
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

  const source = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as Manifest;
  const publicName = source.publishConfig?.name;
  if (typeof publicName !== "string" || !PUBLIC_NAME.test(publicName)) {
    throw new Error(
      `package.json thiếu \`publishConfig.name\` hợp lệ (tên công khai không scope): ${String(publicName)}`,
    );
  }

  const manifestPath = join(unpacked, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  delete manifest.scripts;
  for (const key of Object.keys(manifest.devDependencies ?? {})) {
    if (key.startsWith(UDP_SCOPE)) delete manifest.devDependencies?.[key];
  }
  applyPublicName(manifest, publicName);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  npm(["pack", "--pack-destination", out], unpacked);
  const tarball = tarballIn(out);
  const entries = entriesOf(tarball);
  const packed = manifestIn(tarball);
  assertPublishArtifact(entries, packed, publicName, tarball);
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
