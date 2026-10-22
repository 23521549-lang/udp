import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "@udp/http";
import {
  MetricsQueryError,
  type MetricsSeriesProvider,
  type SeriesWindow,
} from "@udp/metrics-provider";
import {
  DOMAIN_ERROR_SLUGS,
  type RedQuery,
} from "@udp/shared-types/domain-api";
import type { RedMetricsWire } from "@udp/shared-types/wire";
import type { AppDeps } from "../../core/app-deps.js";
import { prisma } from "../../core/db.js";
import { latestWorkloads } from "../architecture/architecture.service.js";
import { metricsBindingFor } from "../capability/metrics-source.resolver.js";
import type { DomainAdapterRegistry } from "../domain/domain-adapter.registry.js";
import { consoleOf } from "./monitoring.console.js";

/**
 * [v4.11, Plan #53 QĐ-4] Request, lỗi, độ trễ theo thời gian cho từng workload của MỘT environment.
 *
 * Đi CÙNG đường với gate canary (§7.4, Plan #39): binding `metrics.query` của environment (bản riêng
 * thắng bản cluster) ⇒ `metricsFor` (proxy API server cho Prometheus trong cụm, egress guard cho
 * SaaS) ⇒ khuôn PromQL/ngôn ngữ nhà cung cấp của `@udp/metrics-provider`. Không một truy vấn nào
 * viết riêng ở đây.
 */

/** Bước theo khoảng nhìn: ≤ 169 điểm mỗi chuỗi, đủ mịn để thấy một sự cố 5 phút ở khung 6 giờ */
export const RED_WINDOWS: Readonly<
  Record<RedQuery["range"], { rangeSec: number; stepSec: number }>
> = {
  "1h": { rangeSec: 3_600, stepSec: 60 },
  "6h": { rangeSec: 21_600, stepSec: 300 },
  "24h": { rangeSec: 86_400, stepSec: 900 },
  "7d": { rangeSec: 604_800, stepSec: 3_600 },
};

/**
 * Tối đa bấy nhiêu workload mỗi lần (workload deploy gần nhất trước): mỗi workload là ba truy vấn
 * chuỗi thời gian lên nguồn của khách.
 */
export const MAX_RED_WORKLOADS = 12;

/** Lưới điểm — cùng công thức với `series()` của provider (mốc chia hết cho bước) */
export function redGrid(
  end: Date,
  rangeSec: number,
  stepSec: number,
): { startSec: number; points: number } {
  const endSec = Math.floor(end.getTime() / 1000);
  const first = Math.floor((endSec - rangeSec) / stepSec) * stepSec;
  const last = Math.floor(endSec / stepSec) * stepSec;
  return { startSec: first, points: (last - first) / stepSec + 1 };
}

export async function redMetrics(args: {
  projectId: string;
  query: RedQuery;
  registry: DomainAdapterRegistry;
  metricsFor: AppDeps["metricsFor"];
  now?: Date;
}): Promise<RedMetricsWire> {
  const { projectId, query } = args;
  const now = args.now ?? new Date();
  const env = await prisma.environment.findFirst({
    where: { id: query.envId, projectId },
    select: { id: true, k8sNamespace: true },
  });
  if (env === null) {
    throw new NotFoundError("Không tìm thấy environment trong project này");
  }
  const binding = await metricsBindingFor({
    projectId,
    environmentId: env.id,
    registry: args.registry,
  });
  if (binding === null) {
    throw new ConflictError(
      "Project chưa có nguồn số đo: bật domain Monitoring để xem request, lỗi và độ trễ",
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.metricsNotEnabled);
  }
  const provider = args.metricsFor(binding.source, undefined, { projectId });
  const { rangeSec, stepSec } = RED_WINDOWS[query.range];
  const window: SeriesWindow = { rangeSec, stepSec, end: now };
  const grid = redGrid(now, rangeSec, stepSec);

  const names = (await latestWorkloads(projectId))
    .filter((w) => w.environmentId === env.id)
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, MAX_RED_WORKLOADS)
    .map((w) => w.workloadName)
    .sort((a, b) => a.localeCompare(b));

  const workloads = await Promise.all(
    names.map((name) =>
      workloadSeries(
        provider,
        { namespace: env.k8sNamespace, workloadName: name },
        window,
      ),
    ),
  ).catch((e: unknown) => {
    if (e instanceof MetricsQueryError) {
      throw new ServiceUnavailableError(
        `Không đọc được số đo từ ${provider.providerId}: ${e.message}`,
      );
    }
    throw e;
  });

  return {
    environmentId: env.id,
    range: query.range,
    stepSeconds: stepSec,
    start: new Date(grid.startSec * 1000).toISOString(),
    points: grid.points,
    source: { providerId: provider.providerId, tool: binding.providedBy },
    console: consoleOf(binding.source, binding.providedBy),
    workloads,
  };
}

async function workloadSeries(
  provider: MetricsSeriesProvider,
  target: { namespace: string; workloadName: string },
  window: SeriesWindow,
): Promise<RedMetricsWire["workloads"][number]> {
  const [requests, errors, latency] = await Promise.all([
    provider.series("requestRate", target, window),
    provider.series("errorRatio", target, window),
    provider.series("latencyP99", target, window),
  ]);
  return {
    workload: target.workloadName,
    requestRate: requests.points.map((p) => p.v),
    errorRatio: errors.points.map((p) => p.v),
    latencyP99Ms: latency.points.map((p) => p.v),
  };
}
