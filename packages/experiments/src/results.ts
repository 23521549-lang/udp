import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Nơi ghi kết quả đo [v4.8] — `docs/measurements/raw/<EXP>-<YYYYMMDD-HHmm>.json`,
 * COMMIT vào repo cùng code đã đo ra chúng. Mỗi file tự mô tả đủ để đọc lại mà
 * không cần phiên làm việc: nguồn code, Node, hệ điều hành, CPU, RAM, và HÌNH HỌC
 * mạng — con số đo trên máy dev tới database ở Singapore là số dev-geometry, không
 * phải số chính thức (§14, §16).
 *
 * Nguồn code: `commit` (HEAD) + `sourceDirty` + `sourceDiffSha256` — sha256 của
 * `git diff HEAD` cộng mọi file chưa theo dõi, CHỈ phần mã: bỏ qua `docs/` (thiết kế,
 * chính các file kết quả) và mọi `*.md` — tài liệu không đổi hành vi, và được sửa
 * sau khi đo. Đo trên cây chưa commit rồi commit đúng mã đó ⇒ hash tái tạo được từ
 * commit cha của nó: kết quả truy về đúng code đã sinh ra nó.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const RAW_DIR = join(repoRoot, "docs", "measurements", "raw");
/** Phần KHÔNG tính vào nguồn: tài liệu và kết quả đo */
const NOT_SOURCE = [":(exclude)docs", ":(exclude,glob)**/*.md"];

/** RAM trống lúc tiến trình đo BẮT ĐẦU — trước khi chính phép đo chiếm bộ nhớ */
const FREE_MEMORY_AT_START = freemem();

export interface Environment {
  commit: string;
  /** Có thay đổi mã nguồn chưa commit (không tính tài liệu và kết quả) */
  sourceDirty: boolean;
  /** sha256 của diff so với HEAD + nội dung file mã chưa theo dõi */
  sourceDiffSha256: string;
  node: string;
  os: string;
  cpu: string;
  cpuCount: number;
  memoryGiB: number;
  /**
   * RAM trống lúc bắt đầu đo — máy dev dùng chung (trình duyệt, IDE): dưới ~2 GiB
   * là máy đang phân trang, micro-benchmark (E3) nhiễu theo.
   */
  freeMemoryGiB: number;
  geometry: string;
  note?: string;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function sourceState(): { dirty: boolean; diffSha256: string } {
  const diff = git(["diff", "HEAD", "--binary", "--", ".", ...NOT_SOURCE]);
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ".",
    ...NOT_SOURCE,
  ])
    .split("\n")
    .filter((f) => f.length > 0)
    .sort();
  const hash = createHash("sha256").update(diff);
  for (const file of untracked) {
    hash.update(`\0${file}\0`);
    hash.update(readFileSync(join(repoRoot, file)));
  }
  return {
    dirty: diff.length > 0 || untracked.length > 0,
    diffSha256: hash.digest("hex"),
  };
}

const gib = (bytes: number): number =>
  Math.round((bytes / 1024 ** 3) * 10) / 10;

export function environment(geometry: string, note?: string): Environment {
  const source = sourceState();
  return {
    commit: git(["rev-parse", "HEAD"]).trim(),
    sourceDirty: source.dirty,
    sourceDiffSha256: source.diffSha256,
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    memoryGiB: gib(totalmem()),
    freeMemoryGiB: gib(FREE_MEMORY_AT_START),
    geometry,
    ...(note === undefined ? {} : { note }),
  };
}

const stamp = (d: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

/** Ghi kết quả; trả đường dẫn file. `note`: ghi chú của người đo (cờ `--note`) */
export function writeResult(
  experiment: string,
  geometry: string,
  data: unknown,
  note?: string,
): string {
  mkdirSync(RAW_DIR, { recursive: true });
  const at = new Date();
  const file = join(RAW_DIR, `${experiment}-${stamp(at)}.json`);
  const body = {
    experiment,
    at: at.toISOString(),
    environment: environment(geometry, note),
    data,
  };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

/** Hình học của mọi phép đo chạy trên máy dev này */
export const DEV_GEOMETRY =
  "dev-box (Windows, cùng máy) → Supabase ap-southeast-1";
export const IN_PROCESS = "in-process (không mạng)";
