import type { z } from "zod";
import { INTERNAL_SECRET_HEADER, METRICS_PROVIDER } from "@udp/config";
import { logger } from "@udp/http";
import type {
  MetricSample,
  MetricTarget,
  MetricsProvider,
  ProbeOutcome,
} from "@udp/metrics-provider";
import type { AdapterResult, MetricQueries } from "@udp/shared-types";
import {
  internalMetricsProbeResponseWire,
  internalMetricsSampleResponseWire,
  internalMetricsSourceResponseWire,
  type InternalMetricsBody,
} from "@udp/shared-types/wire";

/**
 * `MetricsProvider` của Service 3 đi qua Service 1 (Plan #39 QĐ-1, QĐ-2, D-P30).
 *
 * Mỗi phép đo là một `POST /internal/environments/:envId/metrics`: S1 chọn nguồn theo binding
 * `metrics.query` của environment, mở khoá SaaS hay đi `proxyService` tới Prometheus trong
 * cluster — S3 không giữ khoá nào, không giữ token cluster nào.
 *
 * Lời gọi hỏng (S1 chết, hết giờ, trả sai hình) là `hasData: false` — CÙNG luật với Prometheus
 * chết (I7): không bao giờ quy ra 0, nên canary HOLD chứ không tự lên bậc. Probe hỏng là
 * `reachable: false`.
 */

export interface CoreMetricsClientOptions {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Hai lời gọi của S3 tới S1 — một chỗ cho URL, bí mật nội bộ và hạn thời gian */
export interface CoreMetricsClient {
  measure(environmentId: string, body: InternalMetricsBody): Promise<unknown>;
  source(environmentId: string): Promise<unknown>;
}

export function createCoreMetricsClient(
  options: CoreMetricsClientOptions,
): CoreMetricsClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? METRICS_PROVIDER.serviceOneTimeoutMs;
  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const res = await doFetch(`${options.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        [INTERNAL_SECRET_HEADER]: options.secret,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Service 1 trả ${String(res.status)}`);
    return res.json();
  };
  const env = (id: string) =>
    `/internal/environments/${encodeURIComponent(id)}`;
  return {
    measure: (id, body) =>
      call(`${env(id)}/metrics`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    source: (id) => call(`${env(id)}/metrics-source`, { method: "GET" }),
  };
}

type ProbeWire = z.infer<typeof internalMetricsProbeResponseWire>["probe"];

/** Probe từ dây về kiểu của S3 — `exactOptionalPropertyTypes` không nhận khoá mang `undefined` */
function probeResultOf(wire: ProbeWire): AdapterResult<ProbeOutcome> {
  const result: AdapterResult<ProbeOutcome> = { status: wire.status };
  if (wire.message !== undefined) result.message = wire.message;
  if (wire.durationMs !== undefined) result.durationMs = wire.durationMs;
  if (wire.data !== undefined) {
    const { scrapeIntervalSec, ...outcome } = wire.data;
    result.data =
      scrapeIntervalSec === undefined
        ? outcome
        : { ...outcome, scrapeIntervalSec };
  }
  return result;
}

type SampleOp = "errorRate" | "latencyP99" | "requestCount" | "errorCount";

export class RemoteMetricsProvider implements MetricsProvider {
  providerId = "service-1";
  capabilityVersion = "0.0.0";
  scrapeLagSeconds: number;

  constructor(
    private readonly client: CoreMetricsClient,
    private readonly environmentId: string,
    private readonly metricQueries: MetricQueries | null,
    scrapeLagSeconds: number,
  ) {
    this.scrapeLagSeconds = scrapeLagSeconds;
  }

  /** Đọc lại siêu dữ liệu của nguồn — hỏng thì giữ số đang có, không rơi về mặc định */
  async refresh(): Promise<void> {
    try {
      const { source } = internalMetricsSourceResponseWire.parse(
        await this.client.source(this.environmentId),
      );
      this.providerId = source.providerId;
      this.capabilityVersion = source.capabilityVersion;
      this.scrapeLagSeconds = source.scrapeLagSeconds;
    } catch (err: unknown) {
      logger.warn(
        { err, environmentId: this.environmentId },
        "Không đọc được nguồn metrics của environment từ Service 1",
      );
    }
  }

  private withQueries = <T extends object>(body: T) =>
    this.metricQueries === null
      ? body
      : { ...body, metricQueries: this.metricQueries };

  private async sample(
    body: InternalMetricsBody,
    windowSec: number,
  ): Promise<MetricSample> {
    try {
      return internalMetricsSampleResponseWire.parse(
        await this.client.measure(this.environmentId, body),
      ).sample;
    } catch (err: unknown) {
      logger.warn(
        { err, environmentId: this.environmentId, op: body.op },
        "Phép đo qua Service 1 hỏng — mẫu không có dữ liệu",
      );
      return {
        value: 0,
        query: `service-1:${body.op}`,
        windowSeconds: windowSec,
        hasData: false,
      };
    }
  }

  private measure(op: SampleOp, t: MetricTarget, windowSec: number) {
    return this.sample(
      this.withQueries({ op, target: t, windowSec }),
      windowSec,
    );
  }

  errorRate(t: MetricTarget, windowSec: number): Promise<MetricSample> {
    return this.measure("errorRate", t, windowSec);
  }

  latencyP99(t: MetricTarget, windowSec: number): Promise<MetricSample> {
    return this.measure("latencyP99", t, windowSec);
  }

  requestCount(t: MetricTarget, windowSec: number): Promise<MetricSample> {
    return this.measure("requestCount", t, windowSec);
  }

  errorCount(t: MetricTarget, windowSec: number): Promise<MetricSample> {
    return this.measure("errorCount", t, windowSec);
  }

  custom(
    query: string,
    t: MetricTarget,
    windowSec: number,
  ): Promise<MetricSample> {
    return this.sample(
      this.withQueries({ op: "custom" as const, query, target: t, windowSec }),
      windowSec,
    );
  }

  async probe(t: MetricTarget): Promise<AdapterResult<ProbeOutcome>> {
    try {
      return probeResultOf(
        internalMetricsProbeResponseWire.parse(
          await this.client.measure(
            this.environmentId,
            this.withQueries({ op: "probe" as const, target: t }),
          ),
        ).probe,
      );
    } catch (err: unknown) {
      logger.warn(
        { err, environmentId: this.environmentId },
        "Probe qua Service 1 hỏng",
      );
      return {
        status: "FAILED",
        message: "Service 1 không trả lời probe",
        data: {
          reachable: false,
          hasSeries: false,
          queryFailed: false,
          scrapeIntervalSource: "assumed",
        },
      };
    }
  }
}
