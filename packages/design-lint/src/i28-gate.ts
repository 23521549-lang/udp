import { execFileSync, spawnSync } from "node:child_process";
import {
  checkAdapterCommit,
  parseNameStatus,
  type AdapterCommitVerdict,
} from "./adapter-commit.js";

/**
 * Lớp git của cổng I28 (§13.3) [Plan #50]: liệt kê commit trong một khoảng, đọc tệp đổi của từng commit,
 * giao phần phán cho `adapter-commit.ts`.
 *
 * **Điểm bắt đầu:** commit mà cây của nó chưa có module cổng là commit TRƯỚC CỔNG — được báo, không bị
 * chặn. Các lô adapter trước Plan #50 sửa lớp nền trong cùng commit; số của chúng là việc của E1 (đo từ
 * git), không phải của một cổng viết sau. Tiêu chí đọc từ chính cây, không băm cứng SHA nào.
 */

export const GATE_MODULE = "packages/design-lint/src/adapter-commit.ts";

export interface CommitReport {
  commit: string;
  subject: string;
  /** Cây của commit chưa có module cổng */
  preGate: boolean;
  verdict: AdapterCommitVerdict;
}

export interface GateReport {
  /** `base` không giải được (nhánh mới, force-push) ⇒ chỉ kiểm `head` */
  fellBack: boolean;
  commits: CommitReport[];
  violations: CommitReport[];
}

export interface GateOptions {
  cwd: string;
  /** Rỗng, toàn số 0 (sự kiện push của nhánh mới) hay không có trong clone ⇒ chỉ kiểm `head` */
  base?: string | undefined;
  head: string;
}

export function i28Gate({ cwd, base, head }: GateOptions): GateReport {
  const git = (args: readonly string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  const exists = (object: string): boolean =>
    spawnSync("git", ["cat-file", "-e", object], { cwd }).status === 0;
  const lines = (out: string): string[] =>
    out.split(/\r?\n/).filter((l) => l !== "");

  const fellBack =
    base === undefined || /^0*$/.test(base) || !exists(`${base}^{commit}`);
  // `rev^!` = đúng một commit; `--no-merges`: nội dung của merge đã được kiểm ở các commit nó gộp
  const range = fellBack ? [`${head}^!`] : [`${base}..${head}`];
  const shas = lines(git(["rev-list", "--reverse", "--no-merges", ...range]));

  const commits = shas.map((sha): CommitReport => {
    const changes = parseNameStatus(
      git([
        "diff-tree",
        "--root",
        "-r",
        "-z",
        "-M",
        "--no-commit-id",
        "--name-status",
        sha,
      ]),
    );
    return {
      commit: sha,
      subject: git(["log", "-1", "--format=%s", sha]).trim(),
      preGate: !exists(`${sha}:${GATE_MODULE}`),
      verdict: checkAdapterCommit(changes),
    };
  });
  return {
    fellBack,
    commits,
    violations: commits.filter(
      (c) => !c.preGate && c.verdict.outside.length > 0,
    ),
  };
}
