import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { build, type Metafile, type Plugin } from "esbuild";
import { describe, expect, it } from "vitest";
import { readWorkspacePackages, ROOT } from "./workspace.js";

/**
 * [Plan #63 QĐ-1] Mã mà CI chạy NGOÀI tiến trình service không được nạp cấu hình runtime của service.
 *
 * Entry chính của `@udp/config` chạy `envSchema.safeParse(process.env)` và ném ngay lúc NẠP; entry chính của `@udp/db`
 * nạp client Prisma sinh ra (bị gitignore — runner không có). Cả hai là CỐ Ý cho service: fail-fast, chú thích đầu
 * `packages/http/src/index.ts` ghi lý do. Nhưng job ký image, dựng cụm, E2E và cổng phát hành không có cấu hình service
 * nào. Lượt CI đầu tiên (run 37154337078) đỏ đúng ở `signing-e2e.ts`, và phép quét cùng loại tìm ra thêm bốn entry sẽ
 * đỏ ở những job chưa từng chạy tới bước đó (spec Plan #63 §2 G1). Nơi không có env đi qua subpath thuần
 * (`@udp/config/build-toolchain`, `@udp/http/errors`…) — cùng lối thoát mà 61d-3c đã chọn cho `chart:check`.
 *
 * Đo bằng chính bộ phân giải của esbuild (`exports` của package, đường tương đối) trên đúng tệp nguồn: `import type`
 * bị xoá như lúc chạy dưới tsx, nên đồ thị là đồ thị NẠP. Gói bên thứ ba để ngoài — chúng không import mã của UDP.
 */

/** Tệp mà nạp vào là đòi cấu hình của service, hay client Prisma đã sinh */
const FORBIDDEN =
  /^packages\/(?:config\/src\/env\.ts|db\/src\/index\.ts|db\/src\/generated\/)/;
const FORBIDDEN_ON_DISK =
  /[\\/]packages[\\/](?:config[\\/]src[\\/]env\.ts|db[\\/]src[\\/]index\.ts|db[\\/]src[\\/]generated[\\/].*)$/;

/** Specifier trần có hình dạng tên gói npm (hay module có sẵn của Node) — thứ duy nhất được để ngoài */
const PACKAGE_SPECIFIER =
  /^(?:node:.+|(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/.*)?)$/;

/**
 * Entry mà một job KHÔNG có cấu hình service chạy, theo tên package/thư mục. Phần này khai tay vì các job gọi chúng qua
 * script của package (`pnpm deploy:up`, `pnpm --filter @udp/design-lint i28`…); phần gọi THẲNG một tệp thì đọc từ
 * workflow ở `workflowEntries()`.
 */
const ENTRY_GLOBS = [
  // `deploy:up`, `vm-up`, `diagnose` (job kind, vm), test của gói (gate của publish.yml), E2E của hai cụm
  "deploy/src/*.ts",
  "deploy/tests/*.ts",
  "deploy/e2e/*.ts",
  "deploy/e2e-vm/*.ts",
  // toolchain.yml: toolchain:check, chart:check
  "packages/config/scripts/*.ts",
  // i28, chart-bump (job i28), sdk-version (publish.yml, publish-rehearsal.yml)
  "packages/design-lint/scripts/*.ts",
  // pack.ts, build.ts (build-npm, publish-rehearsal)
  "packages/openfeature-provider/scripts/*.ts",
  // E9 ở làn đêm của job kind
  "packages/experiments/scripts/e9.ts",
] as const;

/** Tệp mà workflow gọi thẳng và phép đọc dưới đây PHẢI thấy — đối chứng cho bộ đọc workflow */
const KNOWN_WORKFLOW_ENTRIES = [
  "services/core-backend/scripts/build-smoke.ts",
  "services/core-backend/scripts/signing-e2e.ts",
  "packages/design-lint/scripts/sdk-version.ts",
  "packages/openfeature-provider/scripts/pack.ts",
  "packages/design-lint/tests/package-boundaries.test.ts",
  "packages/design-lint/tests/debt-ledger.test.ts",
  "packages/design-lint/tests/references.test.ts",
] as const;

const posix = (path: string): string => path.replaceAll("\\", "/");

const tracked = (spec: string): string[] =>
  execFileSync("git", ["ls-files", "--", spec], { cwd: ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

/**
 * Tệp mà một workflow gọi THẲNG: `(--filter <@udp/pkg> | -C <thư mục>) exec (tsx | vitest run) <tệp…>`, đọc từ văn bản
 * thô vì lệnh nằm cả ở `run:` lẫn ở `env:` của job (biến `E2E` của `signing-e2e`). Đường của tệp tương đối với
 * package của CHÍNH lệnh đó — bản nháp gán mọi `scripts/*.ts` cho `core-backend` và ra hai tệp không tồn tại.
 */
function workflowEntries(): string[] {
  const dirOf = new Map(
    readWorkspacePackages().map((p) => [p.name, posix(relative(ROOT, p.dir))]),
  );
  const dir = join(ROOT, ".github/workflows");
  const text = readdirSync(dir)
    .filter((file) => file.endsWith(".yml"))
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
  const found = new Set<string>();
  for (const m of text.matchAll(
    /(?:--filter\s+(@udp\/[a-z0-9-]+)|-C\s+([\w./-]+))\s+exec\s+(tsx|vitest\s+run)\s+([^\n"]*)/g,
  )) {
    const [, pkg, cDir, runner, rest] = m;
    const base = pkg === undefined ? cDir : dirOf.get(pkg);
    if (base === undefined)
      throw new Error(`package không có trong workspace: ${String(pkg)}`);
    const files = (rest ?? "")
      .split(/\s+/)
      .filter((token) => /^[\w./-]+\.ts$/.test(token));
    for (const file of runner === "tsx" ? files.slice(0, 1) : files) {
      found.add(posix(join(base, file)));
    }
  }
  return [...found].sort();
}

/**
 * Đẩy ngoài gói bên thứ ba; specifier lạ (alias của tsconfig, `#imports`) thì NÉM — cắt chúng như gói bên thứ ba là
 * cắt im lặng một phần đồ thị. Tệp cấm được thấy trong `metafile` nhưng không đọc tiếp: cổng không cần client Prisma
 * đã sinh, nên bản clone sạch vẫn ra thông điệp đúng thay vì một lỗi resolve.
 */
const udpOnly: Plugin = {
  name: "udp-only",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === "entry-point" || args.path.startsWith("@udp/")) {
        return undefined;
      }
      if (PACKAGE_SPECIFIER.test(args.path)) {
        return { path: args.path, external: true };
      }
      throw new Error(
        `specifier không phải tên gói npm: "${args.path}" (${args.importer})`,
      );
    });
    b.onLoad({ filter: FORBIDDEN_ON_DISK }, () => ({
      contents: "",
      loader: "ts",
    }));
  },
};

async function inputsOf(entry: string): Promise<Metafile["inputs"]> {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: ROOT,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: [udpOnly],
  });
  return result.metafile.inputs;
}

/** Đường import ngắn nhất từ entry tới một tệp — để thông điệp nói phải sửa chỗ nào */
function chainTo(
  inputs: Metafile["inputs"],
  entry: string,
  target: string,
): string {
  const previous = new Map<string, string>();
  const queue = [entry];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === target) break;
    for (const next of inputs[current]?.imports ?? []) {
      if (next.external === true || seen.has(next.path)) continue;
      seen.add(next.path);
      previous.set(next.path, current);
      queue.push(next.path);
    }
  }
  const chain = [target];
  for (let at = previous.get(target); at !== undefined; at = previous.get(at)) {
    chain.unshift(at);
  }
  return chain.join(" → ");
}

/**
 * `import()` mà đối số KHÔNG phải một chuỗi literal: esbuild không đi theo cạnh đó và không cảnh báo (đo trên
 * `domain-adapter.registry.ts`, nơi nạp mọi adapter bằng `import(url)`), nên phần đồ thị sau nó vô hình với cổng này.
 * Một đồ thị không đóng thì đỏ, không được xanh.
 */
function opaqueDynamicImport(file: string): boolean {
  const code = readFileSync(join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return /\bimport\(\s*(?!["'])/.test(code);
}

/** Vi phạm của một entry: tệp cấm nó chạm tới (kèm đường), và tệp có `import()` mờ trong đồ thị của nó */
async function violationsOf(entry: string): Promise<string[]> {
  const inputs = await inputsOf(entry);
  const files = Object.keys(inputs);
  return [
    ...files
      .filter((file) => FORBIDDEN.test(file))
      .map((file) => `nạp ${file}: ${chainTo(inputs, entry, file)}`),
    ...files
      .filter(
        (file) => !FORBIDDEN.test(file) && !file.includes("node_modules/"),
      )
      .filter(opaqueDynamicImport)
      .map(
        (file) =>
          `import() không literal ở ${file}: ${chainTo(inputs, entry, file)}`,
      ),
  ];
}

describe("[Plan #63] entry của CI không nạp cấu hình runtime của service", () => {
  it("mỗi glob của danh sách ra ít nhất một tệp", () => {
    for (const glob of ENTRY_GLOBS) {
      expect(tracked(glob).length, glob).toBeGreaterThan(0);
    }
  });

  it("bộ đọc workflow thấy đủ những tệp đã biết, và mọi tệp nó suy ra đều có thật", () => {
    const entries = workflowEntries();
    expect(entries).toEqual(
      expect.arrayContaining([...KNOWN_WORKFLOW_ENTRIES]),
    );
    expect(entries.filter((file) => !existsSync(join(ROOT, file)))).toEqual([]);
  });

  it("đối chứng dương: entry của Service 1 nạp cả env.ts lẫn client Prisma, và đi qua registry mờ", async () => {
    const violations = await violationsOf("services/core-backend/src/index.ts");
    expect(
      violations.some((v) => v.startsWith("nạp packages/config/src/env.ts")),
    ).toBe(true);
    expect(
      violations.some((v) => v.startsWith("nạp packages/db/src/index.ts")),
    ).toBe(true);
    expect(
      violations.some((v) => v.includes("domain-adapter.registry.ts:")),
    ).toBe(true);
  });

  it(
    "không entry nào nạp cấu hình runtime hay có đồ thị không đóng",
    { timeout: 120_000 },
    async () => {
      const entries = [
        ...new Set([...ENTRY_GLOBS.flatMap(tracked), ...workflowEntries()]),
      ].sort();
      const violations: string[] = [];
      for (const entry of entries) {
        violations.push(...(await violationsOf(entry)));
      }
      expect(violations).toEqual([]);
    },
  );
});
