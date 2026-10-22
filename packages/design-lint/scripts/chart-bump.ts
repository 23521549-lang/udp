import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chartBumpGate } from "../src/chart-bump-gate.js";

/**
 * Cổng CI của **F3** (§8.6) [Plan #61 61d-3c-2]:
 *
 *   pnpm --filter @udp/design-lint chart-bump --base <sha> --head <sha>
 *
 * Commit nào đổi `version` của một chart trong `HELM_CHART_PINS` mà KHÔNG bump version của adapter dùng chart đó
 * và KHÔNG mang version chart cũ vào `upgradesFrom` ⇒ thoát mã 1.
 *
 * Miễn trừ cho một ghim **chưa bao giờ tải về được**: thêm một dòng `Ghim-hỏng: <tên chart>` vào thông điệp commit.
 * Sửa một ghim như vậy không phải một lần nâng cấp §8.6 — không cụm nào từng chạy bản cũ.
 */

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string", default: "HEAD" },
  },
});
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const report = chartBumpGate({
  cwd: repoRoot,
  base: values.base,
  head: values.head,
});

if (report.fellBack) {
  console.log(
    `::warning::F3: base "${values.base ?? ""}" không có trong clone — chỉ kiểm ${values.head}`,
  );
}
for (const c of report.commits) {
  if (c.verdict.changed.length === 0) continue;
  const state = c.preGate
    ? "trước cổng — miễn"
    : c.verdict.violations.length === 0
      ? "đạt"
      : "VI PHẠM";
  const list = c.verdict.changed
    .map((d) => `${d.chart} ${d.from}→${d.to}`)
    .join(", ");
  const excused =
    c.verdict.excused.length === 0
      ? ""
      : ` (miễn: ${c.verdict.excused.join(", ")})`;
  console.log(
    `${c.commit.slice(0, 7)} đổi ghim ${list}: ${state}${excused} — ${c.subject}`,
  );
}
for (const v of report.violations) {
  for (const x of v.verdict.violations) {
    console.log(
      `::error::F3: ${v.commit.slice(0, 7)} đổi ${x.chart} ${x.from}→${x.to} — ${x.reason}`,
    );
  }
}
console.log(
  `F3: ${String(report.commits.length)} commit, ${String(report.violations.length)} vi phạm`,
);
if (report.violations.length > 0) process.exitCode = 1;
