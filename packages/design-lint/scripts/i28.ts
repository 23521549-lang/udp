import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { i28Gate } from "../src/i28-gate.js";

/**
 * Cổng CI của **I28** (§13.3) [Plan #50]:
 *
 *   pnpm --filter @udp/design-lint i28 --base <sha> --head <sha>
 *
 * Commit nào trong khoảng THÊM một tool (`modules/<x>-adapter/<tool>/index.ts` mới) mà đổi cả tệp ngoài thư
 * mục tool mới ⇒ thoát mã 1. Dòng `::error::`/`::warning::` là chú thích của GitHub Actions; chạy tại chỗ
 * thì chỉ là chữ.
 */

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string", default: "HEAD" },
  },
});
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const report = i28Gate({ cwd: repoRoot, base: values.base, head: values.head });

if (report.fellBack) {
  console.log(
    `::warning::I28: base "${values.base ?? ""}" không có trong clone — chỉ kiểm ${values.head}`,
  );
}
for (const c of report.commits) {
  if (c.verdict.tools.length === 0) continue;
  const state = c.preGate
    ? "trước cổng — miễn (E1 đo từ git)"
    : c.verdict.outside.length === 0
      ? "đạt"
      : "VI PHẠM";
  console.log(
    `${c.commit.slice(0, 7)} thêm ${c.verdict.tools.join(", ")}: ${state} — ${c.subject}`,
  );
}
for (const v of report.violations) {
  console.log(
    `::error::I28: ${v.commit.slice(0, 7)} thêm adapter nhưng đổi ${String(v.verdict.outside.length)} tệp ngoài thư mục của nó: ${v.verdict.outside.join(", ")}`,
  );
}
console.log(
  `I28: ${String(report.commits.length)} commit, ${String(report.violations.length)} vi phạm`,
);
if (report.violations.length > 0) process.exitCode = 1;
