import { SDK_STATS, STALE_FLAG_THRESHOLDS } from "@udp/config";
import { loadTimezoneNames } from "@udp/db";
import { NotFoundError, ValidationError } from "@udp/http";
import {
  daysBefore,
  hourFloor,
  hoursBefore,
  type ArchiveStatus,
  type FlagStatsResponse,
  type FlagStatsSummary,
  type StaleFlagsResponse,
} from "@udp/shared-types";
import { prisma } from "../../core/db.js";
import * as flagRepository from "../flag/flag.repository.js";
import { liveRolloutsOf } from "../rollout/rollout.repository.js";
import { archivableAfter, archiveGuardSince } from "./archive-guard.js";
import { classifyStale, type StaleVariantTotal } from "./stale.classifier.js";
import * as repository from "./stats.repository.js";
import {
  flagIdsOf,
  type InternalFlagStatsQuery,
  type InternalStaleFlagsQuery,
  type InternalStatsSummaryQuery,
} from "./stats.types.js";

/**
 * [v4.9] Đường ĐỌC của telemetry (§3.2): stats theo flag, Cleanup Center và
 * sparkline của danh sách flag.
 *
 * Service 2 là nơi DUY NHẤT biết SQL của `flag_evaluation_stats` (R8, V19), nên cả
 * ba câu trả lời được dựng ở đây rồi đi lên Service 1 nguyên vẹn; S1 chỉ kiểm
 * quyền, parse lại bằng schema dùng chung và gắn TÊN environment.
 *
 * Phân công giữa SQL và JS là có chủ đích: SQL đếm, sinh series dày và bão hoà số;
 * JS xếp nhãn (hàm thuần `classifyStale`), định dạng và phân trang. Đảo phần nào
 * sang phía kia cũng được về mặt kết quả, nhưng mỗi phần đang nằm ở chỗ nó rẻ và
 * dễ kiểm nhất.
 *
 * Các câu đọc chạy TUẦN TỰ, không `Promise.all`: pool của S2 có năm khe và dùng
 * chung với `/sdk/config`, nên một lời gọi của Portal không được chiếm cả pool.
 */

/** Không có `asOf` (production) thì "bây giờ" — xem `stats.types.ts` */
const asOfOf = (asOf: string | undefined): Date =>
  asOf === undefined ? new Date() : new Date(asOf);

/**
 * `tz` kiểm LẠI ở S2 dù S1 đã kiểm (V17): route nội bộ không được tin tham số nó
 * nhận, và một tên Postgres không biết sẽ nổ giữa truy vấn thành 500 thay vì 400.
 */
async function assertKnownTimezone(tz: string): Promise<void> {
  const names = await loadTimezoneNames(prisma);
  if (!names.has(tz)) {
    throw new ValidationError(`Postgres không biết múi giờ "${tz}"`);
  }
}

/**
 * Cửa sổ của một lần hỏi stats.
 *
 * `to` là chính `asOf`; `from` lùi sao cho cửa sổ CHẠM đúng `days` bucket:
 * granularity `hour` lùi `days × 24 − 1` giờ tính từ đầu giờ chứa `asOf`, `day`
 * lùi `days − 1` ngày. Không lùi trọn `days` vì bucket chứa `asOf` cũng là một
 * điểm — lùi trọn sinh ra `days + 1` điểm và một cột mở đầu luôn lẻ.
 */
const windowOf = (
  query: { days: number; granularity: "hour" | "day"; tz: string },
  asOf: Date,
): repository.StatsWindow => ({
  granularity: query.granularity,
  tz: query.tz,
  from:
    query.granularity === "hour"
      ? hoursBefore(hourFloor(asOf), query.days * 24 - 1)
      : daysBefore(asOf, query.days - 1),
  to: asOf,
});

/**
 * Khối `archive` — CÙNG dữ liệu với chốt 409 `FLAG_RECENTLY_EVALUATED`, ở dạng có
 * cấu trúc (V10).
 *
 * Thứ tự `blockedBy` khớp thứ tự lỗi của đường GHI (D1.6): rollout sống thắng, vì
 * đó là thứ người dùng kết thúc được ngay; chốt 7 ngày chỉ hết sau nhiều ngày.
 * Flag DRAFT không bị chốt (§6.7), nên `allowed` của nó chỉ phụ thuộc rollout.
 */
function archiveStatusOf(
  lifecycleStatus: string,
  recent: { evalCount: number; lastEvaluatedAt: Date | null },
  rolloutId: string | undefined,
): ArchiveStatus {
  const base = {
    evalCount7d: recent.evalCount,
    lastEvaluatedAt: recent.lastEvaluatedAt?.toISOString() ?? null,
  };
  if (rolloutId !== undefined) {
    return {
      allowed: false,
      blockedBy: "LIVE_ROLLOUT",
      ...base,
      rolloutId,
    };
  }
  const last = recent.lastEvaluatedAt;
  if (lifecycleStatus === "ACTIVE" && recent.evalCount > 0 && last !== null) {
    return {
      allowed: false,
      blockedBy: "RECENT_EVALUATIONS",
      ...base,
      archivableAfter: archivableAfter(last).toISOString(),
    };
  }
  return { allowed: true, ...base };
}

/** Nhãn stats không phải variant của flag (tiền tố `__` bị cấm ở key variant) */
const isStatsLabel = (variantKey: string): boolean =>
  variantKey.startsWith("__");

// ------------------------------------------------------------- stats theo flag

export async function flagStats(
  flagId: string,
  query: InternalFlagStatsQuery,
): Promise<FlagStatsResponse> {
  const flag = await flagRepository.findById(prisma, flagId);
  if (flag === null) throw new NotFoundError("Không tìm thấy flag");
  if (
    query.environmentId !== undefined &&
    !(await flagRepository.environmentInProject(
      prisma,
      flag.projectId,
      query.environmentId,
    ))
  ) {
    throw new NotFoundError(
      "Không tìm thấy environment trong project của flag này",
    );
  }
  await assertKnownTimezone(query.tz);

  const asOf = asOfOf(query.asOf);
  const window = windowOf(query, asOf);
  const totals = await repository.variantTotalsOf(
    prisma,
    flagId,
    window,
    query.environmentId,
  );
  const series = await repository.seriesOf(
    prisma,
    flagId,
    window,
    query.environmentId,
  );
  /**
   * Chốt archive KHÔNG lọc theo `environmentId`, dù phần còn lại của phản hồi có:
   * archive là thao tác toàn cục (bia mộ ở MỌI env), nên một lượt đánh giá ở env
   * khác cũng chặn. Lọc con số này theo env đang xem sẽ cho Portal một `archive`
   * nói "được" trong khi đường ghi trả 409.
   */
  const recent = await repository.recentEvaluationsOf(
    prisma,
    flagId,
    archiveGuardSince(asOf),
  );
  const coverage = await repository.environmentTelemetryOf(
    prisma,
    flag.projectId,
    telemetryWindowOf(asOf),
    query.environmentId,
  );
  const live = await liveRolloutsOf(prisma, [flagId]);

  const known = new Set(flag.variants.map((v) => v.key));
  const pointsOf = new Map<string, { at: string; count: number }[]>();
  for (const point of series) {
    const bucket = pointsOf.get(point.environmentId) ?? [];
    bucket.push({ at: point.at, count: point.count });
    pointsOf.set(point.environmentId, bucket);
  }

  const byEnv = [...new Set(totals.map((row) => row.environmentId))].map(
    (environmentId) => {
      const rows = totals.filter((row) => row.environmentId === environmentId);
      const evalCount = sumOf(rows, (row) => row.count);
      return {
        environmentId,
        evalCount,
        lastEvaluatedAt: maxDate(
          rows.map((row) => row.lastEvaluatedAt),
        )?.toISOString(),
        variants: rows.map((row) => ({
          variantKey: row.variantKey,
          count: row.count,
          /** Chia cho tổng CỦA ENV: mỗi biểu đồ tròn là một environment */
          share: evalCount === 0 ? 0 : row.count / evalCount,
          known: isStatsLabel(row.variantKey) || known.has(row.variantKey),
        })),
        series: pointsOf.get(environmentId) ?? [],
      };
    },
  );

  return {
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      granularity: window.granularity,
      tz: window.tz,
    },
    totals: {
      evalCount: sumOf(totals, (row) => row.count),
      lastEvaluatedAt:
        maxDate(totals.map((row) => row.lastEvaluatedAt))?.toISOString() ??
        null,
    },
    byEnv: byEnv.map((row) => ({
      ...row,
      lastEvaluatedAt: row.lastEvaluatedAt ?? null,
    })),
    archive: archiveStatusOf(flag.lifecycleStatus, recent, live.get(flagId)),
    clientTrafficUnobserved: coverage.some((row) => row.clientKeyActive),
    telemetryGaps: gapsOf(coverage),
  };
}

// ------------------------------------------------------------- Cleanup Center

export async function staleFlags(
  query: InternalStaleFlagsQuery,
): Promise<StaleFlagsResponse> {
  const asOf = asOfOf(query.asOf);
  const candidates = await flagRepository.staleCandidatesOf(
    prisma,
    query.projectId,
  );
  const telemetryStartedAt = await repository.firstReportAtOf(
    prisma,
    query.projectId,
  );
  const flagIds = candidates.map((flag) => flag.id);
  const aggregates = await repository.staleAggregatesOf(prisma, flagIds, {
    unusedSince: daysBefore(asOf, STALE_FLAG_THRESHOLDS.unusedDays),
    settledSince: daysBefore(asOf, STALE_FLAG_THRESHOLDS.settledDays),
    guardSince: archiveGuardSince(asOf),
  });
  const coverage = await repository.environmentTelemetryOf(
    prisma,
    query.projectId,
    telemetryWindowOf(asOf),
  );
  const live = await liveRolloutsOf(prisma, flagIds);

  const rowsOf = new Map<string, repository.StaleAggregateRow[]>();
  for (const row of aggregates) {
    const bucket = rowsOf.get(row.flagId) ?? [];
    bucket.push(row);
    rowsOf.set(row.flagId, bucket);
  }
  const clientTrafficUnobserved = coverage.some((row) => row.clientKeyActive);

  const items = candidates.flatMap((flag) => {
    const lifecycleStatus = flag.lifecycleStatus;
    // Câu đọc đã lọc ARCHIVED; nhánh này chỉ để kiểu nói đúng hình của phản hồi
    if (lifecycleStatus === "ARCHIVED") return [];

    const rows = rowsOf.get(flag.id) ?? [];
    const verdict = classifyStale(flag, variantTotalsOf(rows), {
      asOf,
      telemetryStartedAt,
    });
    const category = verdict.categories[0];
    if (category === undefined) return [];

    const recent = {
      evalCount: sumOf(rows, (row) => row.countGuardWindow),
      lastEvaluatedAt: maxDate(rows.map((row) => row.lastEvaluatedAt)) ?? null,
    };
    return [
      {
        flag: {
          id: flag.id,
          key: flag.key,
          description: flag.description,
          lifecycleStatus,
          flagType: flag.flagType,
          createdAt: flag.createdAt.toISOString(),
          activatedAt: flag.activatedAt?.toISOString() ?? null,
          updatedAt: flag.updatedAt.toISOString(),
        },
        category,
        lastEvaluatedAt: recent.lastEvaluatedAt?.toISOString() ?? null,
        evalCount30d: sumOf(rows, (row) => row.countUnusedWindow),
        ...(verdict.settled === undefined ? {} : { settled: verdict.settled }),
        distribution: variantTotalsOf(rows)
          .filter((total) => total.countSettledWindow > 0)
          .map((total) => ({
            variantKey: total.variantKey,
            count: total.countSettledWindow,
          }))
          .sort(
            (a, b) =>
              b.count - a.count || a.variantKey.localeCompare(b.variantKey),
          ),
        byEnv: [...new Set(rows.map((row) => row.environmentId))].flatMap(
          (environmentId) => {
            const envRows = rows.filter(
              (row) =>
                row.environmentId === environmentId &&
                row.countSettledWindow > 0,
            );
            if (envRows.length === 0) return [];
            return [
              {
                environmentId,
                evalCount14d: sumOf(envRows, (row) => row.countSettledWindow),
                variants: envRows.map((row) => ({
                  variantKey: row.variantKey,
                  count: row.countSettledWindow,
                })),
              },
            ];
          },
        ),
        archive: archiveStatusOf(lifecycleStatus, recent, live.get(flag.id)),
        clientTrafficUnobserved,
      },
    ];
  });

  const counts = { UNUSED: 0, SETTLED: 0, STALE_DRAFT: 0 };
  for (const item of items) counts[item.category] += 1;
  const matching =
    query.category === undefined
      ? items
      : items.filter((item) => item.category === query.category);

  return {
    telemetry: {
      firstReportAt: telemetryStartedAt?.toISOString() ?? null,
      observedDays: observedDaysOf(telemetryStartedAt, asOf),
    },
    telemetryGaps: gapsOf(coverage),
    counts,
    total: matching.length,
    items: matching.slice(query.offset, query.offset + query.limit),
  };
}

// ------------------------------------------------------------- danh sách flag

export async function summary(
  query: InternalStatsSummaryQuery,
): Promise<FlagStatsSummary> {
  await assertKnownTimezone(query.tz);
  const asOf = asOfOf(query.asOf);
  const days = SDK_STATS.query.sparklineDays;
  const flagIds = flagIdsOf(query.flagIds);
  const rows = await repository.summarySeriesOf(
    prisma,
    flagIds,
    query.environmentId,
    {
      granularity: "day",
      tz: query.tz,
      from: daysBefore(asOf, days - 1),
      to: asOf,
    },
    archiveGuardSince(asOf),
  );

  const daily = new Map<string, number[]>();
  const week = new Map<string, number>();
  for (const row of rows) {
    const bucket = daily.get(row.flagId) ?? [];
    bucket.push(row.count);
    daily.set(row.flagId, bucket);
    week.set(row.flagId, row.evalCount7d);
  }

  return {
    items: flagIds.map((flagId) => ({
      flagId,
      evalCount7d: week.get(flagId) ?? 0,
      daily14: fixedLength(daily.get(flagId) ?? [], days),
    })),
  };
}

// ------------------------------------------------------------- phần dùng chung

const telemetryWindowOf = (
  asOf: Date,
): { serverSince: Date; clientSince: Date } => ({
  serverSince: daysBefore(asOf, STALE_FLAG_THRESHOLDS.telemetryGapDays),
  clientSince: daysBefore(asOf, STALE_FLAG_THRESHOLDS.clientTrafficDays),
});

/** V9: environment có khoá SERVER được dùng gần đây mà KHÔNG có hàng stats nào */
const gapsOf = (
  coverage: readonly repository.EnvironmentTelemetryRow[],
): string[] =>
  coverage
    .filter((row) => row.serverKeyActive && !row.hasStats)
    .map((row) => row.environmentId);

const observedDaysOf = (firstReportAt: Date | null, asOf: Date): number =>
  firstReportAt === null
    ? 0
    : Math.max(
        0,
        Math.floor(
          (asOf.getTime() - firstReportAt.getTime()) / (24 * 3_600_000),
        ),
      );

/**
 * Cộng có BÃO HOÀ ở `Number.MAX_SAFE_INTEGER` (V17).
 *
 * SQL đã bão hoà TỪNG nhóm, nhưng tổng của nhiều nhóm trong JS thì vượt lại được
 * — và một `number` vượt 2^53 đi lên dây là một con số sai mà không ai báo lỗi.
 * Ở mức này giá trị đã là "nhiều hơn mọi thứ đếm được", nên cắt là câu trả lời
 * trung thực nhất mà hợp đồng `number` cho phép.
 */
const sumOf = <T>(rows: readonly T[], of: (row: T) => number): number =>
  Math.min(
    Number.MAX_SAFE_INTEGER,
    rows.reduce((sum, row) => sum + of(row), 0),
  );

const maxDate = (dates: readonly (Date | null)[]): Date | undefined => {
  let best: Date | undefined;
  for (const date of dates) {
    if (date !== null && (best === undefined || date > best)) best = date;
  }
  return best;
};

/** Tổng theo VARIANT của một flag, đã cộng mọi environment — đầu vào của T4 */
function variantTotalsOf(
  rows: readonly repository.StaleAggregateRow[],
): StaleVariantTotal[] {
  const totals = new Map<string, StaleVariantTotal>();
  for (const row of rows) {
    const current = totals.get(row.variantKey) ?? {
      variantKey: row.variantKey,
      countUnusedWindow: 0,
      countSettledWindow: 0,
    };
    current.countUnusedWindow += row.countUnusedWindow;
    current.countSettledWindow += row.countSettledWindow;
    totals.set(row.variantKey, current);
  }
  return [...totals.values()];
}

/**
 * `daily14` phải đúng `sparklineDays` phần tử (hợp đồng `flagStatsSummarySchema`).
 *
 * SQL sinh một điểm cho mỗi NGÀY ĐỊA PHƯƠNG mà cửa sổ chạm tới, nên một mốc đổi
 * giờ rơi sát nửa đêm địa phương của `asOf` có thể cho 13 hoặc 15 điểm. Sparkline
 * là hình 14 ô cố định, nên cắt/đệm ở đây: lấy phần MỚI NHẤT, đệm 0 vào đầu. Chốt
 * này thuộc về hợp đồng, không phải về dữ liệu — `series` của stats theo flag
 * KHÔNG bị cắt, vì ở đó cửa sổ thật quan trọng hơn độ dài chẵn.
 */
const fixedLength = (points: readonly number[], size: number): number[] => [
  ...Array.from({ length: Math.max(0, size - points.length) }, () => 0),
  ...points.slice(Math.max(0, points.length - size)),
];
