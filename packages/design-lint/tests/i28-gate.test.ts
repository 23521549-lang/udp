import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkAdapterCommit,
  parseNameStatus,
  toolDirOf,
} from "../src/adapter-commit.js";
import { GATE_MODULE, i28Gate } from "../src/i28-gate.js";

/**
 * **I28** (§13.3) [Plan #50] — cổng CI "thêm adapter không chạm tệp nào ngoài thư mục của nó". Nửa dương
 * tính (adapter giả tự hiện trên catalog) ở `core-backend/tests/domain-catalog.integration.test.ts`.
 */

const MODULES = "services/core-backend/src/modules";
const tool = (domain: string, id: string): string =>
  `${MODULES}/${domain}-adapter/${id}`;

describe("toolDirOf / parseNameStatus", () => {
  it("chỉ `index.ts` ở ĐÚNG tầng thứ hai dưới `<x>-adapter/` là một tool", () => {
    expect(toolDirOf(`${tool("logging", "loki")}/index.ts`)).toBe(
      tool("logging", "loki"),
    );
    expect(toolDirOf(`${tool("logging", "loki")}/sub/index.ts`)).toBeNull();
    expect(toolDirOf(`${MODULES}/adapter-base/helm/index.ts`)).toBeNull();
  });

  it("đọc đầu ra NUL của diff-tree — rename mang hai đường dẫn, tên có khoảng trắng giữ nguyên", () => {
    expect(
      parseNameStatus("A\0a.ts\0R087\0old.ts\0new.ts\0M\0b c.ts\0"),
    ).toEqual([
      { status: "A", paths: ["a.ts"] },
      { status: "R", paths: ["old.ts", "new.ts"] },
      { status: "M", paths: ["b c.ts"] },
    ]);
  });
});

describe("checkAdapterCommit", () => {
  const loki = tool("logging", "loki");

  it("chỉ tệp trong thư mục tool mới ⇒ đạt; tệp ngoài (kể cả tài liệu) ⇒ vi phạm", () => {
    expect(
      checkAdapterCommit([
        { status: "A", paths: [`${loki}/index.ts`] },
        { status: "A", paths: [`${loki}/loki.test.ts`] },
      ]),
    ).toEqual({ tools: [loki], outside: [] });
    expect(
      checkAdapterCommit([
        { status: "A", paths: [`${loki}/index.ts`] },
        { status: "M", paths: ["docs/UDP_design.md"] },
      ]).outside,
    ).toEqual(["docs/UDP_design.md"]);
  });

  it("thư mục anh em cùng tiền tố KHÔNG tính là bên trong", () => {
    expect(
      checkAdapterCommit([
        { status: "A", paths: [`${loki}/index.ts`] },
        { status: "M", paths: [`${loki}-extra/index.ts`] },
      ]).outside,
    ).toEqual([`${loki}-extra/index.ts`]);
  });

  it("hai tool mới trong một commit: tệp của cả hai đều bên trong", () => {
    const tempo = tool("tracing", "tempo");
    expect(
      checkAdapterCommit([
        { status: "A", paths: [`${loki}/index.ts`] },
        { status: "A", paths: [`${tempo}/index.ts`] },
        { status: "A", paths: [`${tempo}/manifests.ts`] },
      ]),
    ).toEqual({ tools: [loki, tempo], outside: [] });
  });

  it("sửa adapter có sẵn, hay đổi tên một tool, không phải thêm tool — ngoài phạm vi I28", () => {
    expect(
      checkAdapterCommit([
        { status: "M", paths: [`${loki}/index.ts`] },
        { status: "M", paths: ["packages/adapter-core/src/domain.ts"] },
      ]),
    ).toEqual({ tools: [], outside: [] });
    expect(
      checkAdapterCommit([
        {
          status: "R",
          paths: [
            `${loki}/index.ts`,
            `${tool("logging", "grafana-loki")}/index.ts`,
          ],
        },
        { status: "M", paths: ["docs/UDP_design.md"] },
      ]).tools,
    ).toEqual([]);
  });
});

describe("i28Gate trên một repo git thật", () => {
  let repo: string;
  const sha: Record<string, string> = {};
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const commit = (name: string, files: Record<string, string>): void => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), body);
    }
    git("add", "-A");
    git("commit", "-q", "-m", name);
    sha[name] = git("rev-parse", "HEAD");
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "udp-i28-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "i28@udp.local");
    git("config", "user.name", "i28");
    git("config", "commit.gpgsign", "false");
    commit("c0 khởi tạo", { "README.md": "x" });
    commit("c1 lô adapter cũ sửa cả lớp nền", {
      [`${tool("logging", "old")}/index.ts`]: "export {}",
      "packages/config/src/domains.ts": "export {}",
    });
    commit("c2 đưa cổng vào", { [GATE_MODULE]: "export {}" });
    commit("c3 thêm adapter đúng luật", {
      [`${tool("logging", "noop")}/index.ts`]: "export {}",
      [`${tool("logging", "noop")}/noop.test.ts`]: "export {}",
    });
    commit("c4 thêm adapter kèm sửa danh mục", {
      [`${tool("tracing", "bad")}/index.ts`]: "export {}",
      "packages/config/src/domains.ts": "export const x = 1",
    });
    commit("c5 sửa adapter có sẵn và tài liệu", {
      [`${tool("logging", "noop")}/index.ts`]: "export const y = 1",
      "docs/note.md": "y",
    });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("commit trước cổng được miễn; commit thêm adapter kèm tệp ngoài là vi phạm DUY NHẤT", () => {
    const report = i28Gate({
      cwd: repo,
      base: sha["c0 khởi tạo"],
      head: "HEAD",
    });
    expect(report.fellBack).toBe(false);
    expect(report.commits.map((c) => c.subject)).toEqual([
      "c1 lô adapter cũ sửa cả lớp nền",
      "c2 đưa cổng vào",
      "c3 thêm adapter đúng luật",
      "c4 thêm adapter kèm sửa danh mục",
      "c5 sửa adapter có sẵn và tài liệu",
    ]);
    const c1 = report.commits[0];
    expect(c1?.preGate).toBe(true);
    expect(c1?.verdict.outside).toEqual(["packages/config/src/domains.ts"]);
    expect(
      report.violations.map((v) => [v.subject, v.verdict.outside]),
    ).toEqual([
      ["c4 thêm adapter kèm sửa danh mục", ["packages/config/src/domains.ts"]],
    ]);
  });

  it("base không giải được (push nhánh mới: toàn số 0) ⇒ chỉ kiểm head, có cờ", () => {
    const report = i28Gate({ cwd: repo, base: "0".repeat(40), head: "HEAD" });
    expect(report.fellBack).toBe(true);
    expect(report.commits.map((c) => c.subject)).toEqual([
      "c5 sửa adapter có sẵn và tài liệu",
    ]);
  });

  it("commit merge không được kiểm lại — nội dung của nó đã kiểm ở các commit nó gộp", () => {
    const before = sha["c5 sửa adapter có sẵn và tài liệu"] ?? "";
    git("checkout", "-q", "-b", "nhanh");
    commit("c6 adapter trên nhánh", {
      [`${tool("tracing", "good")}/index.ts`]: "export {}",
    });
    git("checkout", "-q", "main");
    commit("c7 tài liệu trên main", { "docs/other.md": "z" });
    git("merge", "-q", "--no-ff", "-m", "gộp nhánh", "nhanh");
    const report = i28Gate({ cwd: repo, base: before, head: "HEAD" });
    expect(report.commits.map((c) => c.subject).sort()).toEqual([
      "c6 adapter trên nhánh",
      "c7 tài liệu trên main",
    ]);
    expect(report.violations).toEqual([]);
  });
});
