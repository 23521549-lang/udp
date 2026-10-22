import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  countByKind,
  diffNames,
  interfaceMembers,
  kindOf,
  listConst,
  OUTSIDE_ADAPTERS,
  toolDirOf,
  writeResult,
} from "../src/index.js";

/**
 * **E1** (§14.1) [Plan #42] — effort mở rộng adapter, đo từ lịch sử git từ tag
 * `adapter-interface-v1` (mốc đóng băng bề mặt interface, Plan #18) tới HEAD.
 *
 *   pnpm --filter @udp/experiments e1 [--note "…"]
 *
 * 1. **Phá vỡ interface**: tên phương thức/thuộc tính của `CloudAdapter`, `DomainAdapter`,
 *    `CicdDomainAdapter` ở tag so với HEAD. Bối cảnh `DomainAdapterContext` báo RIÊNG: thêm trường
 *    vào thứ adapter NHẬN không phá adapter có sẵn.
 * 2. **Nới lỏng bộ contract test**: `docs/E1-relaxations.json` (design-lint giữ nó khớp mã).
 * 3. **File ngoài thư mục adapter**: mỗi commit thêm tool (có `index.ts` mới dưới
 *    `*-adapter/<tool>/`), tệp đổi trong commit ấy chia nhóm (`kindOf`). Tool thêm theo lô, cùng
 *    commit với phần mở rộng lớp nền của lô — số là của LÔ, không phải của từng tool.
 *
 * Không mạng, không database: chỉ đọc git — chạy lại trên cùng commit cho cùng số.
 */

const { values } = parseArgs({ options: { note: { type: "string" } } });
const TAG = "adapter-interface-v1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const git = (args: string[]): string =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
const at = (rev: string, path: string): string =>
  git(["show", `${rev}:${path}`]);

function surfacesAt(rev: string) {
  const domain = at(rev, "packages/adapter-core/src/domain.ts");
  const cloud = at(rev, "packages/adapter-core/src/cloud.ts");
  return {
    cloudMethods: listConst(cloud, "CLOUD_ADAPTER_METHODS"),
    domainMethods: listConst(domain, "DOMAIN_ADAPTER_METHODS"),
    domainProperties: listConst(domain, "DOMAIN_ADAPTER_PROPERTIES"),
    cicdMethods: interfaceMembers(domain, "CicdDomainAdapter"),
    context: interfaceMembers(domain, "DomainAdapterContext"),
  };
}

const ADAPTER_INDEX = "services/core-backend/src/modules/*-adapter/*/index.ts";

/** Commit thêm tool: `hash\tsubject` rồi danh sách `index.ts` mới */
function additions(): { hash: string; subject: string; tools: string[] }[] {
  const out: { hash: string; subject: string; tools: string[] }[] = [];
  const raw = git([
    "log",
    "--reverse",
    "--diff-filter=A",
    "--format=@@%H\t%s",
    "--name-only",
    `${TAG}..HEAD`,
    "--",
    ADAPTER_INDEX,
  ]);
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      const [hash = "", subject = ""] = line.slice(2).split("\t");
      out.push({ hash, subject, tools: [] });
    } else if (line.trim() !== "") {
      const dir = toolDirOf(line.trim());
      if (dir !== null)
        out.at(-1)?.tools.push(dir.split("/").slice(-2).join("/"));
    }
  }
  return out;
}

const before = surfacesAt(TAG);
const after = surfacesAt("HEAD");
const adapterSurfaces = [
  "cloudMethods",
  "domainMethods",
  "domainProperties",
  "cicdMethods",
] as const;
const diffs = adapterSurfaces.map(
  (surface) => [surface, diffNames(before[surface], after[surface])] as const,
);
const breaks = Object.fromEntries(diffs);
const breakCount = diffs.reduce(
  (n, [, d]) => n + d.added.length + d.removed.length,
  0,
);

/**
 * Tên giữ nguyên chưa chắc kiểu giữ nguyên: mọi commit sau tag có sửa hai tệp interface — người đọc
 * xem từng cái để biết thay đổi là THÊM (không phá) hay ĐỔI kiểu adapter đang dùng.
 */
const interfaceCommits = git([
  "log",
  "--format=%h\t%s",
  `${TAG}..HEAD`,
  "--",
  "packages/adapter-core/src/domain.ts",
  "packages/adapter-core/src/cloud.ts",
])
  .split(/\r?\n/)
  .filter((l) => l.trim() !== "")
  .map((l) => {
    const [commit = "", subject = ""] = l.split("\t");
    return { commit, subject };
  });

const relaxations = JSON.parse(
  readFileSync(join(repoRoot, "docs/E1-relaxations.json"), "utf8"),
) as { count: number };

const batches = additions().map((c) => {
  const files = git(["show", "--name-only", "--format=", c.hash])
    .split(/\r?\n/)
    .filter((f) => f.trim() !== "");
  return {
    commit: c.hash.slice(0, 7),
    subject: c.subject,
    tools: c.tools,
    files: files.length,
    byKind: countByKind(files),
    outsideAdapters: files.filter((f) => OUTSIDE_ADAPTERS.includes(kindOf(f))),
  };
});

const toolsAtHead = git(["ls-files", "--", ADAPTER_INDEX])
  .split(/\r?\n/)
  .filter((f) => toolDirOf(f) !== null).length;
const toolsAdded = batches.reduce((n, b) => n + b.tools.length, 0);
const outsideTotal = batches.reduce((n, b) => n + b.outsideAdapters.length, 0);

const data = {
  tag: TAG,
  tagCommit: git(["rev-parse", "--short", TAG]).trim(),
  head: git(["rev-parse", "--short", "HEAD"]).trim(),
  interfaceBreaks: { count: breakCount, bySurface: breaks, before, after },
  interfaceFileCommits: interfaceCommits,
  contextExtension: diffNames(before.context, after.context),
  contractRelaxations: relaxations.count,
  toolsAtHead,
  toolsAddedAfterTag: toolsAdded,
  batches,
  outsideAdaptersTotal: outsideTotal,
  outsideAdaptersPerTool:
    toolsAdded === 0 ? 0 : Math.round((outsideTotal / toolsAdded) * 100) / 100,
};

for (const b of batches) {
  console.log(
    `${b.commit} ${String(b.tools.length)} tool, ${String(b.outsideAdapters.length)} tệp ngoài adapter — ${b.subject}`,
  );
}
console.log(
  `phá vỡ interface: ${String(breakCount)}; nới lỏng contract: ${String(relaxations.count)}; bối cảnh thêm: ${data.contextExtension.added.join(", ") || "—"}`,
);
for (const c of interfaceCommits) {
  console.log(`sửa tệp interface: ${c.commit} ${c.subject}`);
}
console.log(
  `đã ghi ${writeResult("E1", "git (không mạng)", data, values.note)}`,
);
