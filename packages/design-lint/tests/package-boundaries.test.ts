import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

interface Pkg {
  name: string;
  dir: string;
  deps: string[];
  /** Chỉ `dependencies` — thứ đi vào runtime */
  runtimeDeps: string[];
}

function readWorkspacePackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const group of ["packages", "services", "apps"]) {
    const base = join(ROOT, group);
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(base, name);
      if (!statSync(dir).isDirectory()) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dir, "package.json"), "utf8");
      } catch {
        continue; // thư mục mới đặt chỗ, chưa có package.json
      }
      const json = JSON.parse(raw) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
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
      });
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
});
