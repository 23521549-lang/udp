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
      else if (e.endsWith(".ts")) out.push(full);
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

  it("mỗi package khai đúng những @udp/* mà nó thật sự import", () => {
    const problems: string[] = [];
    for (const p of packages) {
      const imported = new Set<string>();
      for (const file of sourceFiles(p.dir)) {
        for (const m of readFileSync(file, "utf8").matchAll(
          /from\s+"(@udp\/[^"/]+)/g,
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
});
