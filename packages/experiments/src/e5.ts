import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * E5 (§14) [v4.8] — phần THUẦN của harness: phân rã MTTD từ các mốc QUAN SÁT được,
 * và kiểm file đăng ký giả thuyết trước. Định nghĩa khớp đúng
 * `docs/measurements/E5-preregistration.md` — đổi ở đây là đổi phép đo, phải đi
 * kèm một amendment có ngày trong file đó.
 *
 * Mốc (một miền đồng hồ — mọi thành phần trên cùng máy):
 *   T0        — bơm lỗi (`fault-on` trong timeline của sample-app)
 *   T_scrape  — lần scrape ĐẦU TIÊN của Prometheus sau T0 (`/api/v1/targets`)
 *   T_breach1 — tick phân tích đầu tiên có `breach = true` (`last_decision.at`)
 *   T_decision— tick ra ROLLBACK (`last_decision.at` / `metric_snapshot.at`)
 *   T3        — user cuối của nhóm dò rời `on` (`cohort-cleared`)
 */

export interface E5Marks {
  t0: number;
  tScrape?: number | undefined;
  tBreach1?: number | undefined;
  tDecision?: number | undefined;
  t3?: number | undefined;
}

export interface E5Breakdown {
  /** T_scrape − T0 */
  scrapeLagMs: number | undefined;
  /** T_breach1 − T_scrape: lấp cửa sổ + chờ tick phân tích (không tách được từ ngoài) */
  detectMs: number | undefined;
  /** T_decision − T_breach1: xác nhận chuỗi vượt ngưỡng liên tiếp */
  streakConfirmMs: number | undefined;
  /** T_decision − T0 */
  mttdMs: number | undefined;
  /** T3 − T_decision */
  mttrMs: number | undefined;
}

const gap = (
  later: number | undefined,
  earlier: number | undefined,
): number | undefined =>
  later === undefined || earlier === undefined ? undefined : later - earlier;

export function decompose(marks: E5Marks): E5Breakdown {
  for (const [name, value] of [
    ["tScrape", marks.tScrape],
    ["tBreach1", marks.tBreach1],
    ["tDecision", marks.tDecision],
    ["t3", marks.t3],
  ] as const) {
    if (value !== undefined && value < marks.t0) {
      throw new RangeError(
        `${name} trước T0 — sai miền đồng hồ hoặc sai phiên`,
      );
    }
  }
  return {
    scrapeLagMs: gap(marks.tScrape, marks.t0),
    detectMs: gap(marks.tBreach1, marks.tScrape),
    streakConfirmMs: gap(marks.tDecision, marks.tBreach1),
    mttdMs: gap(marks.tDecision, marks.t0),
    mttrMs: gap(marks.t3, marks.tDecision),
  };
}

/**
 * Blast radius theo ĐÚNG thiết kế: request được PHỤC VỤ nhánh lỗi trong [T0, T3]
 * — sample-app đếm `servedOn` từ lúc bơm và chốt nó tại T3. Ước lượng đối chiếu:
 * (MTTD + MTTR) × RPS × tỉ trọng checkout × tỉ lệ canary — khoảng [T0, T3] gồm CẢ
 * thời gian phát hiện, nên với MTTD như nhau giữa các nhánh, tỉ số blast radius là
 * tỉ số (MTTD + MTTR), KHÔNG phải tỉ số MTTR.
 */
export function blastEstimate(
  breakdown: Pick<E5Breakdown, "mttdMs" | "mttrMs">,
  rps: number,
  checkoutShare: number,
  canaryShare: number,
): number | undefined {
  if (breakdown.mttdMs === undefined || breakdown.mttrMs === undefined) {
    return undefined;
  }
  return (
    ((breakdown.mttdMs + breakdown.mttrMs) / 1000) *
    rps *
    checkoutShare *
    canaryShare
  );
}

/** Một lần đọc bộ đếm tích luỹ của sample-app (`/chaos/timeline`) */
export interface CounterSample {
  at: number;
  servedAll: number;
  failedAll: number;
}

/**
 * Tỉ lệ lỗi người dùng trong [from, to] từ chuỗi bộ đếm TÍCH LUỸ — đối chứng âm
 * của E5 so cửa sổ 60 s trước và sau T_decision. Dùng mẫu gần nhất ở mỗi đầu
 * (mẫu đầu tiên ≥ from, mẫu cuối cùng ≤ to); thiếu mẫu ⇒ `undefined`.
 */
export function errorRateBetween(
  series: readonly CounterSample[],
  from: number,
  to: number,
): number | undefined {
  const start = series.find((s) => s.at >= from);
  const end = [...series].reverse().find((s) => s.at <= to);
  if (start === undefined || end === undefined || end.at <= start.at) {
    return undefined;
  }
  const served = end.servedAll - start.servedAll;
  return served <= 0 ? undefined : (end.failedAll - start.failedAll) / served;
}

/**
 * Độ lệch đồng hồ Prometheus so với máy đo (ms): Prometheus chạy trong VM của
 * Docker Desktop — đồng hồ riêng. Từ một lần hỏi `time()` bọc giữa hai mốc
 * `Date.now()`: offset = t_prom − (trước + sau) / 2.
 */
export function clockOffsetMs(
  promSeconds: number,
  before: number,
  after: number,
): number {
  return promSeconds * 1000 - (before + after) / 2;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const PREREGISTRATION = "docs/measurements/E5-preregistration.md";

export interface PreregistrationStatus {
  /** Commit gần nhất chạm file; `undefined` = chưa từng commit */
  commit: string | undefined;
  /** File có sửa đổi chưa commit */
  dirty: boolean;
}

export function preregistrationStatus(
  root: string = repoRoot,
): PreregistrationStatus {
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = git(["log", "-1", "--format=%H", "--", PREREGISTRATION]);
  const dirty =
    git(["status", "--porcelain", "--", PREREGISTRATION]).length > 0;
  return { commit: commit.length > 0 ? commit : undefined, dirty };
}
