import { execFileSync, spawnSync } from "node:child_process";
import {
  checkChartBump,
  PINS_FILE,
  type AdapterFile,
  type ChartBumpVerdict,
} from "./chart-bump.js";

/**
 * [Plan #61 61d-3c-2] Lớp git của cổng F3: liệt kê commit trong một khoảng, đọc nội dung hai phía của
 * `helm-charts.ts` và của mọi tệp adapter mà commit chạm, giao phần phán cho `chart-bump.ts`.
 *
 * **Điểm bắt đầu:** commit mà cây của nó chưa có `helm-charts.ts` là commit TRƯỚC CỔNG — được báo, không bị chặn.
 * Cùng kỷ luật với cổng I28 (`i28-gate.ts`): tiêu chí đọc từ chính cây, không băm cứng SHA nào.
 */

export interface ChartBumpReport {
  commit: string;
  subject: string;
  /** Cây của commit chưa có bảng ghim ⇒ ngoài phạm vi cổng */
  preGate: boolean;
  verdict: ChartBumpVerdict;
}

export interface ChartBumpGateReport {
  fellBack: boolean;
  commits: ChartBumpReport[];
  violations: ChartBumpReport[];
}

const ADAPTER_FILE = /^services\/core-backend\/src\/modules\/.*\.ts$/;

export function chartBumpGate({
  cwd,
  base,
  head,
}: {
  cwd: string;
  base?: string | undefined;
  head: string;
}): ChartBumpGateReport {
  const git = (args: readonly string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  const exists = (object: string): boolean =>
    spawnSync("git", ["cat-file", "-e", object], { cwd }).status === 0;
  /** Nội dung một tệp ở một commit; tệp chưa tồn tại ⇒ chuỗi rỗng (không ném) */
  const show = (sha: string, path: string): string =>
    exists(`${sha}:${path}`) ? git(["show", `${sha}:${path}`]) : "";

  const fellBack =
    base === undefined || /^0*$/.test(base) || !exists(`${base}^{commit}`);
  const range = fellBack ? [`${head}^!`] : [`${base}..${head}`];
  const shas = git(["rev-list", "--reverse", "--no-merges", ...range])
    .split(/\r?\n/)
    .filter((l) => l !== "");

  const commits = shas.map((sha): ChartBumpReport => {
    const parent = `${sha}^`;
    const hasParent = exists(`${parent}^{commit}`);
    const pinsAfter = show(sha, PINS_FILE);
    const pinsBefore = hasParent ? show(parent, PINS_FILE) : "";

    /** Tệp adapter mà commit CHẠM — chỉ chúng mới chứng minh được một lượt bump */
    const touched = git([
      "diff-tree",
      "--root",
      "-r",
      "--no-commit-id",
      "--name-only",
      sha,
    ])
      .split(/\r?\n/)
      .filter((p) => ADAPTER_FILE.test(p) && !p.endsWith(".test.ts"));

    const adapters: AdapterFile[] = touched.map((path) => ({
      path,
      before: hasParent ? show(parent, path) : "",
      after: show(sha, path),
    }));

    return {
      commit: sha,
      subject: git(["log", "-1", "--format=%s", sha]).trim(),
      preGate: pinsAfter === "",
      verdict: checkChartBump({
        pinsBefore,
        pinsAfter,
        adapters,
        commitMessage: git(["log", "-1", "--format=%B", sha]),
      }),
    };
  });

  return {
    fellBack,
    commits,
    violations: commits.filter(
      (c) => !c.preGate && c.verdict.violations.length > 0,
    ),
  };
}
