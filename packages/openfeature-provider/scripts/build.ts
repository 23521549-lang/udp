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

await build({
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
  banner: {
    js: "// @udp/openfeature-provider — mã bên thứ ba góp vào: xem THIRD_PARTY_NOTICES",
  },
  logLevel: "warning",
});

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
