import { Router, type Request } from "express";
import {
  asyncHandler,
  NotFoundError,
  requireInternalCaller,
  sendJson,
  uuidParam,
  validateBody,
} from "@udp/http";
import {
  PrometheusMetricsProvider,
  type MetricsProvider,
  type MetricTarget,
} from "@udp/metrics-provider";
import {
  internalMetricsBodyWire,
  internalMetricsProbeResponseWire,
  internalMetricsSampleResponseWire,
  internalMetricsSourceResponseWire,
  type InternalMetricsBody,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../core/app-deps.js";
import { prisma } from "../core/db.js";
import { metricsSourceFor } from "../modules/capability/metrics-source.resolver.js";

/**
 * Route nội bộ Service 3 → Service 1 (§9, Plan #39, D-P30): S1 thực thi MỘT phép đo trên nguồn
 * `metrics.query` của environment — khoá SaaS và đường tới cluster không rời S1. Mount NGOÀI
 * `/api/v1` (không CSRF, không rate limiter người dùng, không bao giờ qua ingress công khai),
 * sau `requireInternalCaller` (§12 T12 bước một).
 *
 * Nguồn chọn theo CÙNG luật với probe pha 1 (`metricsSourceFor`): bản riêng của environment thắng
 * bản cluster, nhiều provider mà không chọn ⇒ 422. S3 coi mọi trả lời không phải 200 là
 * `hasData: false` — HOLD, không bao giờ 0 (I7).
 */
export const internalMetricsRouter: Router = Router();

async function providerOf(
  req: Request,
  metricQueries: InternalMetricsBody["metricQueries"],
): Promise<MetricsProvider> {
  const environmentId = uuidParam(req, "envId", "Mã environment không hợp lệ");
  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { projectId: true },
  });
  if (environment === null) {
    throw new NotFoundError("Không tìm thấy environment");
  }
  const { projectId } = environment;
  const deps = appDepsOf(req);
  const source = await metricsSourceFor({
    projectId,
    environmentId,
    registry: await deps.domainRegistry(),
  });
  return deps.metricsFor(source, metricQueries, { projectId });
}

/** Đích đo từ dây — `exactOptionalPropertyTypes` không nhận khoá mang `undefined` */
function targetOf(wire: InternalMetricsBody["target"]): MetricTarget {
  const target: MetricTarget = {
    namespace: wire.namespace,
    workloadName: wire.workloadName,
  };
  if (wire.version !== undefined) target.version = wire.version;
  if (wire.flagKey !== undefined) target.flagKey = wire.flagKey;
  if (wire.variantKey !== undefined) target.variantKey = wire.variantKey;
  return target;
}

internalMetricsRouter.get(
  "/environments/:envId/metrics-source",
  requireInternalCaller,
  asyncHandler(async (req, res) => {
    const provider = await providerOf(req, undefined);
    // PromQL đo được scrape interval thật; nguồn SaaS có số cố định của lô xuất
    if (provider instanceof PrometheusMetricsProvider) {
      await provider.refreshScrapeLag();
    }
    sendJson(res, internalMetricsSourceResponseWire, {
      source: {
        providerId: provider.providerId,
        capabilityVersion: provider.capabilityVersion,
        scrapeLagSeconds: provider.scrapeLagSeconds,
      },
    });
  }),
);

internalMetricsRouter.post(
  "/environments/:envId/metrics",
  requireInternalCaller,
  validateBody(internalMetricsBodyWire),
  asyncHandler(async (req, res) => {
    const body = req.body as InternalMetricsBody;
    const provider = await providerOf(req, body.metricQueries);
    const target = targetOf(body.target);
    if (body.op === "probe") {
      sendJson(res, internalMetricsProbeResponseWire, {
        probe: await provider.probe(target),
      });
      return;
    }
    const sample =
      body.op === "custom"
        ? await provider.custom(body.query, target, body.windowSec)
        : await provider[body.op](target, body.windowSec);
    sendJson(res, internalMetricsSampleResponseWire, { sample });
  }),
);
