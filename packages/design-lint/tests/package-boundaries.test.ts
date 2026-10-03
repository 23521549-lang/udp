import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  goldenPathPins,
  projectNameOf,
  projectVersionOf,
} from "../src/toml-version.js";

/**
 * Ranh giới package là quyết định hạng nhất, nên nó phải được KIỂM.
 *
 * Hai ràng buộc dưới đây trước kia chỉ sống trong chú thích đầu file
 * `packages/shared-types/src/index.ts`. Trong chính plan này tôi đã suýt xoá
 * file đó vì một agent QA nhận xét "không ai import barrel" — và cùng với nó là
 * hai ràng buộc kiến trúc, biến mất không dấu vết. Chú thích mất theo file;
 * test thì không.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");

interface Manifest {
  name: string;
  version?: string;
  private?: boolean;
  license?: string;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  repository?: { url?: string; directory?: string };
}

interface Pkg {
  name: string;
  dir: string;
  deps: string[];
  /** Chỉ `dependencies` — thứ đi vào runtime */
  runtimeDeps: string[];
  manifest: Manifest;
}

/**
 * [Plan #62 62b-2] Danh sách thành viên lấy từ `pnpm-workspace.yaml`, KHÔNG từ một mảng thư mục viết cứng.
 *
 * Bản trước quét `["packages", "services", "apps"]`, còn yaml khai thêm `deploy` — nên `@udp/deploy` (package
 * giữ cổng workflow của cả repo) nằm NGOÀI tầm quét của mọi ô trong tệp này, và mọi mệnh đề "mỗi package…" có
 * một lỗ fail-open im lặng đúng ở đó. Cùng hình dạng với lỗi `chartPinsOf` của Plan #61 (chỉ thấy 42 trong 71
 * chart): một phép đếm thiếu mà kết quả vẫn trông hợp lý.
 *
 * Bộ đọc fail-closed: dòng đầu phải là `packages:`, mọi dòng sau phải là một mục `- "<glob>"`, và MỖI glob phải
 * ra ít nhất một package — một glob không khớp gì nghĩa là yaml và đĩa đã lệch.
 */
function workspaceGlobs(): string[] {
  const raw = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const lines = raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !l.trimStart().startsWith("#"));
  const [head, ...rest] = lines;
  if (head?.trim() !== "packages:") {
    throw new Error(
      `pnpm-workspace.yaml: dòng đầu phải là "packages:", đang là ${String(head)}`,
    );
  }
  const globs = rest.map((line) => {
    const matched = /^\s*-\s*"([^"]+)"\s*$/.exec(line);
    if (matched === null) {
      throw new Error(`pnpm-workspace.yaml: dòng không đọc được: ${line}`);
    }
    return matched[1] ?? "";
  });
  if (globs.length === 0) {
    throw new Error("pnpm-workspace.yaml không khai thành viên nào");
  }
  return globs;
}

function readWorkspacePackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const glob of workspaceGlobs()) {
    const base = glob.endsWith("/*") ? glob.slice(0, -2) : null;
    const dirs =
      base === null
        ? [join(ROOT, glob)]
        : readdirSync(join(ROOT, base))
            .map((name) => join(ROOT, base, name))
            .filter((dir) => statSync(dir).isDirectory());
    let found = 0;
    for (const dir of dirs) {
      let raw: string;
      try {
        raw = readFileSync(join(dir, "package.json"), "utf8");
      } catch {
        continue; // thư mục mới đặt chỗ, chưa có package.json
      }
      const json = JSON.parse(raw) as Manifest;
      found += 1;
      out.push({
        name: json.name,
        dir,
        deps: Object.keys({
          ...json.dependencies,
          ...json.devDependencies,
        }).filter((d) => d.startsWith("@udp/")),
        runtimeDeps: Object.keys(json.dependencies ?? {}).filter((d) =>
          d.startsWith("@udp/"),
        ),
        manifest: json,
      });
    }
    if (found === 0) {
      throw new Error(
        `pnpm-workspace.yaml khai "${glob}" mà không có package nào — yaml và đĩa đã lệch`,
      );
    }
  }
  return out;
}

/** Mọi file .ts của package, bỏ qua mã sinh tự động */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e === "dist" || e === "generated") continue;
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      /**
       * [v4.11] `.tsx` cũng tính. `".tsx".endsWith(".ts")` là **false**, nên bản trước
       * mù hoàn toàn với mã React — và một ô ranh giới quét 0 tệp thì xanh vĩnh viễn,
       * đúng loại bảo đảm mà `adapter-lint-glob.test.ts` tồn tại để chống. Sửa TRƯỚC khi
       * có tệp `.tsx` đầu tiên, để cái chốt sẵn sàng lúc nó cần.
       */
      else if (e.endsWith(".ts") || e.endsWith(".tsx")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * [Plan #62 62d-11] Đọc một hằng chuỗi BẰNG CHỮ từ `render.ts` — design-lint không phụ thuộc `@udp/golden-path`.
 *
 * Fail-closed theo bài học `chartPinsOf` (chỉ thấy 42 trong 71 chart): một mẫu regex đòi một hình dạng cố định sẽ
 * **thiếu khớp im lặng** khi prettier xuống dòng, khi ai đó thêm annotation kiểu, hay khi đổi sang nháy đơn. Mẫu
 * một tầng mà đợt 62b dùng (`/PROVIDER_RELEASE\s*=\s*"…"/`) có chú thích nói nó chặn `PROVIDER_RELEASE_LEGACY` —
 * đo ra nó **không** chặn, vì sau định danh là `_LEGACY` chứ không phải `\s*=`. Nên ở đây:
 *
 *   - mốc đối chiếu là phép **đếm định danh thô** (`split`, không regex) — thứ không vỡ vì hình dạng khai báo;
 *   - phép đọc đi **hai tầng**: tầng một bắt phần phải của `=` lỏng, tầng hai đọc chặt và **in nguyên văn** thứ nó
 *     thấy khi lạ — một mẫu một tầng ở đúng chỗ đó cho 0 khớp và không lời giải thích nào;
 *   - `uses >= 2` là mệnh đề một regex thuần không phát biểu được: nó bắt đúng thoái cấp "khai hằng rồi bỏ phép
 *     thay trong `render()`", lúc đó mọi phép so tên vẫn khớp mà cây sinh ra thì không còn được đổi tên.
 */
function constantOf(source: string, name: string): string {
  const uses = source.split(name).length - 1;
  const decls = [
    ...source.matchAll(
      /^export const ([A-Z][A-Z0-9_]*)(?:\s*:\s*[^=\n]+?)?\s*=\s*([\s\S]{1,80}?);$/gm,
    ),
  ].filter((m) => m[1] === name);
  if (decls.length !== 1) {
    throw new Error(
      `render.ts phải có ĐÚNG MỘT khai báo ${name}, thấy ${String(decls.length)} ` +
        `(định danh xuất hiện ${String(uses)} lần)`,
    );
  }
  if (uses < 2) {
    throw new Error(
      `${name} được khai mà KHÔNG được dùng trong render() (xuất hiện ${String(uses)} lần)`,
    );
  }
  const rhs = (decls[0]?.[2] ?? "").trim();
  const literal = /^"([^"]*)"(?:\s+as const)?$/.exec(rhs);
  if (literal === null) {
    throw new Error(
      `${name} phải là literal nháy kép một dòng, đang là: ${rhs}`,
    );
  }
  return literal[1] ?? "";
}

const packages = readWorkspacePackages();
const byName = new Map(packages.map((p) => [p.name, p]));

describe("ranh giới package", () => {
  it("không có vòng phụ thuộc", () => {
    const cycles: string[] = [];
    const state = new Map<string, "visiting" | "done">();

    const visit = (name: string, path: string[]): void => {
      if (state.get(name) === "done") return;
      if (state.get(name) === "visiting") {
        cycles.push([...path, name].join(" → "));
        return;
      }
      state.set(name, "visiting");
      for (const dep of byName.get(name)?.deps ?? [])
        visit(dep, [...path, name]);
      state.set(name, "done");
    };

    for (const p of packages) visit(p.name, []);
    expect(cycles).toEqual([]);
  });

  it("@udp/shared-types KHÔNG phụ thuộc @udp/db", () => {
    // Đây là chỗ DUY NHẤT tạo được vòng `db → shared-types → db`: `db` cần
    // shared-types cho schema của `serve`, nên chiều ngược lại phải đóng.
    const st = byName.get("@udp/shared-types");
    expect(st, "không tìm thấy package @udp/shared-types").toBeDefined();
    expect((st as Pkg).deps).not.toContain("@udp/db");

    const offenders = sourceFiles((st as Pkg).dir)
      .filter((f) => /from\s+"@udp\/db/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(ROOT, ""));
    expect(offenders).toEqual([]);
  });

  /**
   * [v4.10] `@udp/adapter-core` KHÔNG phụ thuộc `@udp/db`.
   *
   * Đây là cách giữ ma trận writer §1.2 bằng CẤU TRÚC thay vì bằng kỷ luật lập
   * trình: chỉ Service 1 được ghi các bảng adapter, và một adapter không thể ghi
   * thẳng vào database dù muốn, vì client không có ở đó để mà import. Không có
   * phép kiểm này thì lời hứa đó chỉ là một dòng trong `package.json`.
   *
   * Nó cũng là điều kiện để lưới khôi phục 130 ô chạy được mà không cần database:
   * runner nhận sổ qua một cổng, nên bản trong bộ nhớ là một hiện thực hợp lệ.
   */
  it("@udp/adapter-core KHÔNG phụ thuộc @udp/db", () => {
    const core = byName.get("@udp/adapter-core");
    expect(core, "không tìm thấy package @udp/adapter-core").toBeDefined();
    expect((core as Pkg).deps).not.toContain("@udp/db");

    const offenders = sourceFiles((core as Pkg).dir)
      .filter((f) => /from\s+"@udp\/db/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(ROOT, ""));
    expect(offenders).toEqual([]);
  });

  /**
   * Bốn subpath, không ba và không năm.
   *
   * Mỗi subpath là một ranh giới có chủ đích: `.` là hợp đồng mà adapter hiện thực,
   * `./runner` là cổng runner dùng, `./testing` là hiện thực giả tất định,
   * `./contract` là bộ test hợp đồng dùng chung. Thêm một subpath thứ năm mà không
   * nói ra là cách một package biến thành package thần thánh.
   */
  it("@udp/adapter-core khai đúng bốn subpath", () => {
    const core = byName.get("@udp/adapter-core") as Pkg;
    const json = JSON.parse(
      readFileSync(join(core.dir, "package.json"), "utf8"),
    ) as { exports: Record<string, string> };
    expect(Object.keys(json.exports).sort()).toEqual([
      ".",
      "./contract",
      "./runner",
      "./testing",
    ]);
  });

  /**
   * `@udp/adapter-core` chỉ được import subpath thuần của `@udp/config`.
   *
   * Cùng lý lẽ với `shared-types`: entry chính của `@udp/config` chạy env validation
   * lúc nạp module. Một package mà bộ test hợp đồng của người ngoài nhóm sẽ import
   * (kiểm soát (b) của E1) không được đòi họ phải có `.env` đầy đủ.
   */
  it("@udp/adapter-core chỉ import subpath thuần của @udp/config", () => {
    const core = byName.get("@udp/adapter-core") as Pkg;
    const allowed = new Set(["@udp/config/constants", "@udp/config/domains"]);
    const offenders: string[] = [];
    for (const file of sourceFiles(core.dir)) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /from\s+"(@udp\/config[^"]*)"/g,
      )) {
        if (!allowed.has(m[1] as string))
          offenders.push(`${file.replace(ROOT, "")}: ${m[1] as string}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("@udp/shared-types chỉ import subpath @udp/config/constants", () => {
    // Entry chính của `@udp/config` chạy env validation lúc nạp module và ném
    // lỗi nếu thiếu biến. Một package chỉ chứa type mà kéo theo tác dụng phụ đó
    // sẽ làm mọi thứ import nó — kể cả test và công cụ — phải có .env đầy đủ.
    const st = byName.get("@udp/shared-types") as Pkg;
    const offenders: string[] = [];
    for (const file of sourceFiles(st.dir)) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /from\s+"(@udp\/config[^"]*)"/g,
      )) {
        if (m[1] !== "@udp/config/constants")
          offenders.push(`${file.replace(ROOT, "")}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("[v4.6] @udp/flag-evaluator chạy được trong ứng dụng của khách: chỉ shared-types và @udp/config/constants", () => {
    // Lõi đánh giá (§6.5) nằm trong SDK/provider của khách (I26). Kéo `@udp/db`,
    // `@udp/http` hay entry chính của `@udp/config` (validate `.env` của UDP lúc
    // nạp) vào đó là bắt ứng dụng khách mang hạ tầng của UDP theo.
    const fe = byName.get("@udp/flag-evaluator") as Pkg;
    const offenders: string[] = [];
    for (const file of sourceFiles(fe.dir)) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /from\s+"(@udp\/[^"]*)"/g,
      )) {
        const spec = m[1] as string;
        if (spec !== "@udp/shared-types" && spec !== "@udp/config/constants")
          offenders.push(`${file.replace(ROOT, "")}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("[v4.7] @udp/openfeature-provider chạy trong ứng dụng của khách: src/ chỉ lõi đánh giá, shared-types và @udp/config/constants", () => {
    // Test của provider được dựng Service 2 và dùng database (devDependencies) —
    // nên chỉ quét `src/`. `@openfeature/*` và `prom-client` là PEER: ứng dụng
    // cung cấp, không có trong dependencies.
    const pv = byName.get("@udp/openfeature-provider") as Pkg;
    const allowed = new Set([
      "@udp/flag-evaluator",
      "@udp/shared-types",
      "@udp/config/constants",
    ]);
    const offenders: string[] = [];
    for (const file of sourceFiles(join(pv.dir, "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /from\s+"(@udp\/[^"]*)"/g,
      )) {
        if (!allowed.has(m[1] as string))
          offenders.push(`${file.replace(ROOT, "")}: ${String(m[1])}`);
      }
    }
    expect(offenders).toEqual([]);

    // [v4.8] Khách chỉ cài TARBALL: `@udp/*` và thư viện của chúng được GÓP VÀO
    // bundle (`scripts/build.ts`), nên `dependencies` RỖNG — ba package nội bộ
    // nằm ở devDependencies (build và test trong monorepo cần chúng). SDK
    // OpenFeature và prom-client là PEER: bản riêng của provider đăng ký
    // histogram vào registry KHÁC `/metrics` của app, series biến mất im lặng
    const json = JSON.parse(
      readFileSync(join(pv.dir, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(json.dependencies ?? {}).toEqual({});
    for (const internal of allowed) {
      const name = internal.split("/").slice(0, 2).join("/");
      expect(json.devDependencies ?? {}).toHaveProperty([name]);
    }
    for (const peer of [
      "@openfeature/server-sdk",
      "@openfeature/core",
      "prom-client",
    ]) {
      expect(json.peerDependencies ?? {}).toHaveProperty([peer]);
    }

    // Entry chính (provider, hook) không kéo prom-client: chỉ middleware ở subpath `/metrics`
    const promImports = sourceFiles(join(pv.dir, "src"))
      .filter((f) => !f.endsWith("metrics.ts"))
      .filter((f) =>
        /(?:from\s+|import\s*\(?\s*)"prom-client"/.test(
          readFileSync(f, "utf8"),
        ),
      );
    expect(promImports).toEqual([]);
  });

  it("[v4.8] sample-app là ỨNG DỤNG KHÁCH: src/ chỉ dùng entry công khai của provider", () => {
    // Nó là hiện thực tham chiếu của Golden Path (§11): chạm vào `@udp/config`
    // (validate `.env` của UDP), lõi đánh giá hay subpath `./testing` là chứng minh
    // một thứ khách KHÔNG làm được
    const app = byName.get("@udp/sample-app") as Pkg;
    const allowed = new Set([
      "@udp/openfeature-provider",
      "@udp/openfeature-provider/metrics",
    ]);
    const offenders: string[] = [];
    for (const file of sourceFiles(join(app.dir, "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /from\s+"(@udp\/[^"]*)"/g,
      )) {
        if (!allowed.has(m[1] as string))
          offenders.push(`${file.replace(ROOT, "")}: ${String(m[1])}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("[v4.11, Plan #48] mã template Golden Path là mã của KHÁCH: chỉ entry công khai của provider", () => {
    // Developer chép nguyên cây này vào repo của họ — một import nội bộ (`@udp/config`, `./testing`,
    // lõi đánh giá) là mã không chạy được ngoài monorepo
    const golden = byName.get("@udp/golden-path") as Pkg;
    const allowed = new Set([
      "@udp/openfeature-provider",
      "@udp/openfeature-provider/metrics",
    ]);
    const offenders: string[] = [];
    for (const dir of ["templates/node/src", "templates/node/tests"]) {
      for (const file of sourceFiles(join(golden.dir, dir))) {
        for (const m of readFileSync(file, "utf8").matchAll(
          /from\s+"(@udp\/[^"]*)"/g,
        )) {
          if (!allowed.has(m[1] as string))
            offenders.push(`${file.replace(ROOT, "")}: ${String(m[1])}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("mỗi package khai đúng những @udp/* mà nó thật sự import", () => {
    const problems: string[] = [];
    for (const p of packages) {
      const imported = new Set<string>();
      for (const file of sourceFiles(p.dir)) {
        /**
         * [v4.11] Chỉ CÂU LỆNH `import`/`export … from` ở đầu dòng. Bản trước khớp
         * `from "@udp/…"` ở bất cứ đâu, kể cả bên trong một chuỗi — Portal hiển thị
         * đoạn mã mẫu `import { udpMetricsMiddleware } from "@udp/openfeature-provider/…"`
         * cho người dùng chép, và cổng đọc nó thành một phụ thuộc của Portal.
         */
        for (const m of readFileSync(file, "utf8").matchAll(
          /^(?:import|export)\b[^;]*?\sfrom\s+"(@udp\/[^"/]+)/gm,
        )) {
          if (m[1] !== undefined) imported.add(m[1]);
        }
      }
      for (const dep of imported) {
        if (!p.deps.includes(dep))
          problems.push(`${p.name} import ${dep} nhưng không khai`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("[v4.4] @udp/test-support chỉ là devDependency và không ai import nó ở src/", () => {
    // Package này dựng TIẾN TRÌNH service thật và ghi thẳng database bằng owner —
    // lọt vào runtime là một service tự chạy service khác. Chú thích đầu package
    // nói điều đó; test này làm nó thành luật.
    const problems: string[] = [];
    for (const p of packages) {
      if (p.runtimeDeps.includes("@udp/test-support")) {
        problems.push(`${p.name} khai @udp/test-support trong dependencies`);
      }
      if (p.name === "@udp/test-support") continue;
      for (const file of sourceFiles(join(p.dir, "src"))) {
        if (/from\s+"@udp\/test-support/.test(readFileSync(file, "utf8"))) {
          problems.push(`${file.replace(ROOT, "")} import @udp/test-support`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  /**
   * [Plan #62 62b-2] Bỏ `"private": true` của gói SDK là mở một đường trước đây đóng, nên tính chất "chỉ gói đó
   * được phát hành" phải có một ô. Trước đợt này **không chỗ nào** trong repo đọc `private` của một package
   * workspace (đã grep), nên nó chưa từng được canh.
   *
   * "Đúng MỘT" chứ không "hai": `sdks/python` KHÔNG là thành viên pnpm workspace (không có `package.json`, và
   * `pnpm-workspace.yaml` không khai `sdks/*`). Viết "hai" thì ô này hoặc đỏ mãi, hoặc tệ hơn: người sau "sửa"
   * bằng cách bỏ `private` của một package khác — đúng thoái cấp mà ô này tồn tại để chống.
   */
  it("[Plan #62] đúng MỘT package của workspace không private, và nó là gói SDK Node", () => {
    const publishable = packages
      .filter((p) => p.manifest.private !== true)
      .map((p) => p.name)
      .sort();
    expect(publishable).toEqual(["@udp/openfeature-provider"]);
  });

  /** `@udp/deploy` là thành viên mà bộ đọc cũ không thấy — ô này giữ nó trong tầm quét */
  it("[Plan #62] mọi glob của pnpm-workspace.yaml đều có package, và deploy nằm trong tầm quét", () => {
    expect(packages.map((p) => p.name)).toContain("@udp/deploy");
    expect(packages.filter((p) => p.name === "").map((p) => p.dir)).toEqual([]);
  });

  it("[Plan #62] manifest phát hành của gói SDK đủ thứ registry đòi, và `files` không mở rộng", () => {
    const pv = byName.get("@udp/openfeature-provider") as Pkg;
    // `files` đúng `["dist"]`: `LICENSE` và `README.md` vào tarball bằng LUẬT của npm/pnpm, không bằng khai báo —
    // thêm chúng vào đây là một dòng vô tác dụng dạy người đọc rằng `files` là danh sách đầy đủ.
    expect(pv.manifest.files).toEqual(["dist"]);
    expect(pv.manifest.license).toBe("Apache-2.0");
    // Provenance của npm đối chiếu `repository.url` với repo đã build, và phép khớp là CASE-SENSITIVE
    expect(pv.manifest.repository?.url).toBe(
      "git+https://github.com/23521549-lang/udp.git",
    );
    expect(pv.manifest.repository?.directory).toBe(
      "packages/openfeature-provider",
    );
    for (const file of ["LICENSE", "README.md"]) {
      expect(existsSync(join(pv.dir, file))).toBe(true);
    }
  });

  /**
   * [Plan #62 62b-3] Hai SDK đi cùng một số version: §6.8 nói hai bản có cùng máy trạng thái, cùng tuỳ chọn, cùng
   * mặc định, và tương đương được kiểm bằng CÙNG MỘT tệp vector. Hai số version rời nhau cho hai bản được kiểm
   * bằng cùng một tệp là mời người đọc đoán xem bản Python nào tương đương bản Node nào.
   *
   * Và Golden Path phải ghim ĐÚNG dải tính ra từ version đó, chứ không phải "một khoảng nào có chứa version":
   * `>=0.1,<1` chứa cả `0.2.0` còn `^0.1.0` thì không, nên phép "có chứa" cho phép một khoảng rộng tuỳ ý.
   */
  it("[Plan #62] hai SDK cùng một số version, và Golden Path ghim đúng dải của version đó", () => {
    const node = byName.get("@udp/openfeature-provider") as Pkg;
    const python = projectVersionOf(
      readFileSync(join(ROOT, "sdks", "python", "pyproject.toml"), "utf8"),
    );
    expect(node.manifest.version).toBe(python);

    const pins = goldenPathPins(python);
    const render = readFileSync(
      join(ROOT, "packages", "golden-path", "src", "render.ts"),
      "utf8",
    );
    expect(constantOf(render, "PROVIDER_RELEASE")).toBe(pins.providerRelease);

    const requirements = readFileSync(
      join(
        ROOT,
        "packages",
        "golden-path",
        "templates",
        "python",
        "requirements.txt",
      ),
      "utf8",
    );
    expect(
      requirements
        .split(/\r?\n/)
        .filter((line) => line.includes("udp-openfeature")),
    ).toEqual([pins.requirement]);
  });

  /**
   * Bộ đọc `[project].version` phải FAIL-CLOSED. Mỗi đầu vào dưới đây là một chế độ hỏng mà một mẫu regex hồn
   * nhiên trả về một giá trị SAI thay vì ném — đo trên tám đầu vào trước khi viết bộ đọc.
   */
  it("[Plan #62] projectVersionOf ném ở mọi dạng lạ, không đoán", () => {
    const ok = ['[project]\nversion = "1.2.3"\n'];
    for (const good of ok) expect(projectVersionOf(good)).toBe("1.2.3");

    const bad: [string, string][] = [
      ["chỉ có dòng bị comment", '[project]\n# version = "9.9.9"\n'],
      ["version động (setuptools-scm)", '[project]\ndynamic = ["version"]\n'],
      ["nháy đơn", "[project]\nversion = '1.2.3'\n"],
      ["hai khoá version", '[project]\nversion = "1.2.3"\nversion = "1.2.4"\n'],
      ["không có bảng [project]", 'version = "1.2.3"\n'],
      [
        "chỉ có [tool.poetry].version",
        '[tool.poetry]\nversion = "9.9.9"\n[project]\nname = "x"\n',
      ],
      ["version không phải x.y.z", '[project]\nversion = "1.2"\n'],
    ];
    for (const [why, source] of bad) {
      expect(() => projectVersionOf(source), why).toThrow();
    }

    // `target-version` của `[tool.ruff]` đứng TRƯỚC `[project]` — mẫu `/version\s*=\s*"…"/` đọc ra "py311"
    expect(
      projectVersionOf(
        '[tool.ruff]\ntarget-version = "py311"\n[project]\nversion = "1.2.3"\n',
      ),
    ).toBe("1.2.3");
  });

  /**
   * [Plan #62 62d-11] Tên PHÁT HÀNH nói ở **bốn** chỗ, và không chỗ nào được trôi khỏi ba chỗ kia:
   * `publishConfig.name` (nguồn sự thật), `PROVIDER_PUBLIC_NAME` của Golden Path (cây sinh cho khách),
   * `[project].name` của `pyproject.toml` (câu "một tên, hai registry" thành bất biến thay vì khẩu hiệu), và —
   * ở ô kế tiếp — mọi bề mặt Portal.
   *
   * Scope `@udp` **không bao giờ lấy được**: npm đã có package `udp@1.0.0`, và org với package dùng chung một
   * không gian tên. Nên `@udp/*` là namespace CỦA KHO, và một tên có scope ở `publishConfig.name` là một lượt
   * publish chắc chắn hỏng ở registry — sau khi chốt duyệt tay đã tiêu.
   */
  it("[Plan #62] tên phát hành khớp ở bốn chỗ, và không có scope", () => {
    const pv = byName.get("@udp/openfeature-provider") as Pkg;
    const published = (pv.manifest as { publishConfig?: { name?: string } })
      .publishConfig?.name;
    expect(published).toBeDefined();
    expect(published).toMatch(/^[a-z][a-z0-9-]*$/);

    const render = readFileSync(
      join(ROOT, "packages", "golden-path", "src", "render.ts"),
      "utf8",
    );
    expect(constantOf(render, "PROVIDER_PUBLIC_NAME")).toBe(published);

    const pyproject = readFileSync(
      join(ROOT, "sdks", "python", "pyproject.toml"),
      "utf8",
    );
    expect(projectNameOf(pyproject)).toBe(published);
  });

  /**
   * Mã mà Portal ĐƯA CHO NGƯỜI DÙNG dán phải mang tên phát hành. Một phép QUÉT, không một danh sách tệp: danh
   * sách sẽ lỗi ở đoạn mã thứ ba, và đợt này đã có đúng hai (`sdk-quickstart.ts` và `rollout-form.tsx`) mà bản
   * nháp chỉ kể một.
   *
   * Hai wire fixture cũng vào đây: nội dung tệp đề xuất của `repo-scan` do `goldenPathFiles` sinh, và chúng là
   * nguồn của mock Portal lẫn bản xem thử công khai — `wire-golden.test.ts` chỉ parse schema nên nó không đỏ.
   */
  it("[Plan #62] không bề mặt nào của khách còn mang tên trong kho", () => {
    const inRepo = `${["@udp", ""].join("/")}openfeature-provider`;
    const offenders: string[] = [];
    for (const dir of [
      join(ROOT, "apps", "portal", "src"),
      join(ROOT, "services", "core-backend", "tests", "fixtures", "wire"),
    ]) {
      for (const file of readdirSync(dir, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!file.isFile()) continue;
        const full = join(file.parentPath, file.name);
        if (readFileSync(full, "utf8").includes(inRepo)) {
          offenders.push(full.slice(ROOT.length + 1).replaceAll("\\", "/"));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
