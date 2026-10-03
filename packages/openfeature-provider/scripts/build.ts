import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Đóng gói provider cho ứng dụng KHÁCH (§6.8) [v4.8] — thứ `pnpm pack` đưa vào
 * tarball qua `publishConfig`.
 *
 *   - JS: esbuild, hai entry ESM (`index`, `metrics`) với `splitting` — lõi đánh
 *     giá nằm trong MỘT chunk chung, hai entry dùng cùng một bản. `@udp/*` và hai
 *     thư viện của chúng (zod, murmurhash3js) được GÓP VÀO bundle: khách không cài
 *     gì của UDP ngoài tarball, và entry chính của `@udp/config` (validate `.env`
 *     của UDP lúc nạp) không bao giờ tới được. Peer (`@openfeature/*`,
 *     `prom-client`) để ngoài: bản riêng của provider đăng ký histogram vào
 *     registry KHÁC với `/metrics` của ứng dụng.
 *   - Kiểu: `tsc --emitDeclarationOnly` chỉ từ hai entry — chữ ký công khai không
 *     nhắc kiểu nội bộ nào (chỗ tiêm test nằm ở `internals.ts`).
 *   - Giấy phép của mã bên thứ ba đã góp vào: `dist/THIRD_PARTY_NOTICES`.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const PEERS = ["@openfeature/server-sdk", "@openfeature/core", "prom-client"];
/** Thư viện được góp vào bundle — mỗi cái PHẢI có giấy phép đi kèm */
const INLINED = ["zod", "murmurhash3js"];

rmSync(dist, { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: { index: "src/index.ts", metrics: "src/metrics.ts" },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: [...PEERS, "node:*"],
  legalComments: "none",
  metafile: true,
  banner: {
    js: "// udp-openfeature — mã bên thứ ba góp vào: xem THIRD_PARTY_NOTICES",
  },
  logLevel: "warning",
});

/**
 * [Plan #62 62b-6] `INLINED` là một danh sách VIẾT TAY, và `THIRD_PARTY_NOTICES` được sinh từ nó. Một `import` mới
 * ở `@udp/flag-evaluator` hay `@udp/shared-types` góp một thư viện thứ ba vào bundle mà notices vẫn hai mục — và
 * artifact phát hành vi phạm điều khoản attribution của chính giấy phép Apache-2.0 mà gói khai. Không test nào bắt
 * được: nó là một mệnh đề về bundle, không về mã nguồn.
 *
 * Nên đo bundle THẬT bằng `metafile` và khẳng định nó khớp danh sách đã khai. `INLINED` **vẫn** là một hằng viết
 * tay chứ không suy ra từ metafile: viết thành danh sách là cách để việc "thêm một thư viện vào bundle" là một
 * quyết định NHÌN THẤY ĐƯỢC; suy ra thì notices không bao giờ lệch, nhưng cũng không bao giờ ai thấy.
 *
 * Tên lấy sau lần `node_modules/` CUỐI: layout của pnpm là `.pnpm/zod@3.25.76/node_modules/zod/lib/index.mjs`.
 * Package của workspace (`@udp/*`) vào bundle bằng đường mã nguồn thật (esbuild phân giải symlink) nên không có
 * `node_modules/` trong đường dẫn và không bị đếm — đúng ý: chúng là mã của UDP, nằm dưới giấy phép của gói.
 */
const MODULES = "node_modules/";
const bundled = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const path = input.replaceAll("\\", "/");
  const at = path.lastIndexOf(MODULES);
  if (at === -1) continue;
  const rest = path.slice(at + MODULES.length);
  const parts = rest.split("/");
  const name = rest.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? "");
  if (name !== "") bundled.add(name);
}
const declared = [...INLINED].sort();
const measured = [...bundled].sort();
if (declared.join("|") !== measured.join("|")) {
  const extra = measured.filter((n) => !declared.includes(n));
  const missing = declared.filter((n) => !measured.includes(n));
  throw new Error(
    [
      "THIRD_PARTY_NOTICES sẽ không khớp bundle:",
      `  khai (INLINED): ${declared.join(", ")}`,
      `  đo (metafile):  ${measured.join(", ")}`,
      extra.length > 0
        ? `  vào bundle mà KHÔNG được khai: ${extra.join(", ")} — thêm vào INLINED (và kiểm giấy phép của nó tương thích Apache-2.0) hay bỏ import kéo nó vào`
        : "",
      missing.length > 0
        ? `  khai mà KHÔNG vào bundle: ${missing.join(", ")} — bỏ khỏi INLINED`
        : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

const requireFromEvaluator = createRequire(
  join(root, "..", "flag-evaluator", "package.json"),
);
/** Thư mục gốc của một package đã cài: đi lên từ file entry tới `package.json` cùng tên */
function packageDir(name: string): string {
  let dir = dirname(requireFromEvaluator.resolve(name));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
      };
      if (pkg.name === name) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`không tìm thấy gốc của ${name}`);
    dir = parent;
  }
}
const notices = INLINED.map((name) => {
  const dir = packageDir(name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    version: string;
    license?: string;
  };
  const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"]
    .map((f) => join(dir, f))
    .find((f) => existsSync(f));
  const text =
    licenseFile === undefined
      ? `(${pkg.license ?? "không rõ"} — package không kèm file giấy phép)`
      : readFileSync(licenseFile, "utf8").trim();
  return `${name}@${pkg.version} — ${pkg.license ?? "?"}\n\n${text}`;
});
writeFileSync(
  join(dist, "THIRD_PARTY_NOTICES"),
  `${notices.join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
);

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});

/**
 * tsc sinh `.d.ts` cho MỌI file hai entry kéo theo, kể cả file nội bộ nhắc
 * `@udp/*` (khách không phân giải được). Chỉ giữ những file đi tới được từ hai
 * entry qua `import`/`export … from "./x.js"`; phần còn lại là rác của tarball.
 */
const types = join(dist, "types");
const reachable = new Set<string>();
/**
 * Đường dẫn tương đối tới một file `.d.ts` khác: `from "./x.js"`, `import("./x.js")`,
 * kể cả thư mục con (`./sub/x.js`) — cùng tập mà `package.test.ts` kiểm
 */
const RELATIVE = /(?:from\s+|import\(\s*)"(\.\.?\/[^"]+)\.js"/g;
const visit = (file: string): void => {
  if (reachable.has(file)) return;
  reachable.add(file);
  const text = readFileSync(join(types, file), "utf8");
  for (const m of text.matchAll(RELATIVE)) {
    const target = join(dirname(file), `${m[1] ?? ""}.d.ts`).replaceAll(
      "\\",
      "/",
    );
    visit(target);
  }
};
visit("index.d.ts");
visit("metrics.d.ts");
for (const entry of readdirSync(types, {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile()) continue;
  const file = relative(types, join(entry.parentPath, entry.name)).replaceAll(
    "\\",
    "/",
  );
  if (!reachable.has(file)) rmSync(join(types, file));
}
