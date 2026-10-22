import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRootManifest, readWorkspacePackages, ROOT } from "./workspace.js";

/**
 * [Plan #63 QĐ-7] README là thứ người clone đọc đầu tiên, và nó đã nói sai về chính repo: "Node.js ≥ 20" trong khi
 * `engines` đòi `>=22.22.2` (đòi từ 61d-1, `@sigstore/verify` 4), và cây thư mục thiếu bốn package, `deploy/`,
 * `sdks/python/`. Không ai bắt được vì không phép kiểm nào đọc README — một tài liệu không có cổng trôi khỏi mã.
 */

const readme = readFileSync(join(ROOT, "README.md"), "utf8").replaceAll(
  "\r\n",
  "\n",
);
/** Khối mã đầu tiên mở bằng `udp/` — cây thư mục của mục "Cấu trúc" */
const tree = /```\nudp\/\n([\s\S]*?)```/.exec(readme)?.[1] ?? "";
const requirements = /## Yêu cầu\n([\s\S]*?)\n## /.exec(readme)?.[1] ?? "";
const root = readRootManifest();

describe("[Plan #63] README nói đúng về repo", () => {
  it("cây thư mục có mọi package của workspace, và sdks/python", () => {
    expect(
      tree.length,
      "README phải có khối cây mở bằng `udp/`",
    ).toBeGreaterThan(0);
    const dirs = [
      ...readWorkspacePackages().map((p) => basename(p.dir)),
      "sdks",
      "python",
    ];
    expect(
      dirs.filter((dir) => !new RegExp(`[├└]── ${dir}/`).test(tree)),
    ).toEqual([]);
  });

  it("phần Yêu cầu nói đúng phiên bản Node và pnpm mà repo đòi", () => {
    const node = /^>=(\d+\.\d+\.\d+)$/.exec(root.engines?.["node"] ?? "")?.[1];
    const pnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(root.packageManager ?? "")?.[1];
    expect(node, "engines.node của gốc phải có dạng >=x.y.z").toBeDefined();
    expect(
      pnpm,
      "packageManager của gốc phải có dạng pnpm@x.y.z",
    ).toBeDefined();
    expect(requirements).toContain(`Node.js ≥ ${node ?? ""}`);
    expect(requirements).toContain(`pnpm ${pnpm ?? ""}`);
  });
});
