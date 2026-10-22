import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENV_SCOPED,
  NOT_ENV_SCOPED,
  qk,
  type QueryKeyName,
} from "../src/lib/query-keys";

/**
 * Bất biến I38 (§10.14): mọi query thuộc phạm vi environment có `envId` trong key, và
 * ngoại lệ phải KHAI. Không có nó thì dữ liệu `dev` cache lẫn sang `prod` — loại lỗi rất
 * khó thấy bằng mắt.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(e) ? [full] : [];
  });
}

const ENV_SENTINEL = "ENV-SENTINEL-7f3a";

/** Gọi hàm key với mỗi tham số là một chuỗi riêng — rồi xem `envId` có trong key không */
function keyWith(name: QueryKeyName, envArgIndex: number): readonly unknown[] {
  const fn = qk[name] as (...args: unknown[]) => readonly unknown[];
  const args = Array.from({ length: fn.length }, (_, i) =>
    i === envArgIndex ? ENV_SENTINEL : `arg-${String(i)}`,
  );
  return fn(...args);
}

/** Vị trí tham số `envId` theo tên trong mã nguồn của hàm key */
function envArgIndexOf(name: QueryKeyName): number {
  const src = (qk[name] as (...a: unknown[]) => unknown).toString();
  const params = src.slice(src.indexOf("(") + 1, src.indexOf(")")).split(",");
  return params.findIndex((p) => p.trim().startsWith("envId"));
}

describe("I38: query key theo phạm vi environment", () => {
  const all = Object.keys(qk) as QueryKeyName[];

  it("mọi key đều được phân loại: ENV_SCOPED hoặc NOT_ENV_SCOPED, không bỏ sót", () => {
    const classified = new Set<string>([
      ...ENV_SCOPED,
      ...Object.keys(NOT_ENV_SCOPED),
    ]);
    expect(all.filter((k) => !classified.has(k))).toEqual([]);
  });

  it("không key nào vừa env-scoped vừa được miễn trừ", () => {
    const both = ENV_SCOPED.filter((k) => k in NOT_ENV_SCOPED);
    expect(both).toEqual([]);
  });

  for (const name of ENV_SCOPED) {
    it(`${name}: nhận envId và envId NẰM TRONG key`, () => {
      const idx = envArgIndexOf(name);
      expect(idx, `${name} không có tham số envId`).toBeGreaterThanOrEqual(0);
      expect(keyWith(name, idx)).toContain(ENV_SENTINEL);
    });
  }

  it("ma trận flag × env được miễn trừ có lý do (§10.14)", () => {
    expect(NOT_ENV_SCOPED.flagEnvs).toContain("MỌI env");
  });

  it("không tệp nào ngoài query-keys.ts viết `queryKey: [` trần", () => {
    const files = walk(SRC).filter((f) => !f.endsWith("query-keys.ts"));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) =>
      /queryKey:\s*\[/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("đối chứng: một key env-scoped KHÔNG có envId thì phép kiểm trên bắt được", () => {
    const broken = (projectId: string) => ["flags", projectId] as const;
    const src = broken.toString();
    const params = src.slice(src.indexOf("(") + 1, src.indexOf(")")).split(",");
    expect(params.findIndex((p) => p.trim().startsWith("envId"))).toBe(-1);
  });
});
