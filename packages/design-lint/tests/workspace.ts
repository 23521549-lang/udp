import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Bộ đọc workspace dùng chung của các cổng `design-lint` — MỘT bộ đọc, vì một bộ đọc thứ hai là một lỗ quét (bài học
 * 62b-2 bên dưới). [Plan #63] Tách khỏi `package-boundaries.test.ts` khi có thêm ba tệp cần nó: `ci-entry-purity`,
 * `script-names`, `readme`.
 */

export const ROOT = resolve(import.meta.dirname, "../../..");

export interface Manifest {
  name: string;
  version?: string;
  private?: boolean;
  license?: string;
  files?: string[];
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  repository?: { url?: string; directory?: string };
}

export interface Pkg {
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

export function readWorkspacePackages(): Pkg[] {
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

/** Manifest của gốc repo — nó không là thành viên của workspace nhưng mang `engines`, `packageManager` và lệnh gốc */
export function readRootManifest(): Manifest {
  return JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ) as Manifest;
}
