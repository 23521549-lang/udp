import { METRICS_PROVIDER } from "@udp/config/constants";
import type { AdapterResult } from "@udp/shared-types";
import type {
  MetricSample,
  MetricTarget,
  MetricsProvider,
  ProbeOutcome,
} from "./provider.js";
import { ffLabel } from "./query-templates.js";

/**
 * Nguồn metrics giả, có kịch bản — cho test của Service 3 và cho kịch bản bơm
 * lỗi §13.4 chạy không cần Prometheus.
 *
 * Kịch bản đặt theo KHOÁ của nhánh: `"<flagKey>=<variant>"` (FLAG_LEVEL) hoặc
 * `version` (SERVICE_LEVEL). Nhánh không có kịch bản trả `hasData: false` —
 * đúng hình dạng "Prometheus không có series", để test I7 không phải dựng gì
 * thêm. Mọi lời gọi được ghi lại để test khẳng định S3 đo cái gì, cửa sổ nào.
 */
export interface FakeBranch {
  requests: number;
  errors: number;
  p99Ms?: number;
}

export interface FakeCall {
  kind: "requestCount" | "errorCount" | "errorRate" | "latencyP99" | "custom";
  key: string;
  windowSec: number;
}

export function branchKeyOf(t: MetricTarget): string {
  if (t.flagKey !== undefined && t.variantKey !== undefined) {
    return ffLabel(t.flagKey, t.variantKey);
  }
  return t.version ?? "*";
}

export class FakeMetricsProvider implements MetricsProvider {
  readonly providerId = "fake";
  readonly capabilityVersion = "0.0";
  readonly scrapeLagSeconds: number;
  readonly calls: FakeCall[] = [];
  private readonly branches = new Map<string, FakeBranch>();
  private reachable = true;

  constructor(options: { scrapeLagSeconds?: number } = {}) {
    this.scrapeLagSeconds =
      options.scrapeLagSeconds ?? METRICS_PROVIDER.defaultScrapeLagSeconds;
  }

  /** Đặt kịch bản cho một nhánh; gọi lại là thay */
  set(key: string, branch: FakeBranch): this {
    this.branches.set(key, branch);
    return this;
  }

  /** Xoá kịch bản — nhánh về "không có dữ liệu" */
  clear(key?: string): this {
    if (key === undefined) this.branches.clear();
    else this.branches.delete(key);
    return this;
  }

  setReachable(reachable: boolean): this {
    this.reachable = reachable;
    return this;
  }

  private sample(
    kind: FakeCall["kind"],
    t: MetricTarget,
    windowSec: number,
    pick: (b: FakeBranch) => number | undefined,
  ): Promise<MetricSample> {
    const key = branchKeyOf(t);
    this.calls.push({ kind, key, windowSec });
    const branch = this.branches.get(key);
    const value = branch === undefined ? undefined : pick(branch);
    return Promise.resolve({
      value: value ?? 0,
      query: `fake:${kind}{${key}}`,
      windowSeconds: windowSec,
      hasData: value !== undefined && this.reachable,
    });
  }

  requestCount(t: MetricTarget, w: number): Promise<MetricSample> {
    return this.sample("requestCount", t, w, (b) => b.requests);
  }

  errorCount(t: MetricTarget, w: number): Promise<MetricSample> {
    return this.sample("errorCount", t, w, (b) => b.errors);
  }

  errorRate(t: MetricTarget, w: number): Promise<MetricSample> {
    return this.sample("errorRate", t, w, (b) =>
      b.requests === 0 ? undefined : b.errors / b.requests,
    );
  }

  latencyP99(t: MetricTarget, w: number): Promise<MetricSample> {
    return this.sample("latencyP99", t, w, (b) => b.p99Ms);
  }

  custom(query: string, t: MetricTarget, w: number): Promise<MetricSample> {
    this.calls.push({ kind: "custom", key: branchKeyOf(t), windowSec: w });
    return Promise.resolve({
      value: 0,
      query,
      windowSeconds: w,
      hasData: false,
    });
  }

  probe(t: MetricTarget): Promise<AdapterResult<ProbeOutcome>> {
    const prefix =
      t.flagKey === undefined ? (t.version ?? "*") : `${t.flagKey}=`;
    const hasSeries = [...this.branches.keys()].some((k) =>
      k.startsWith(prefix),
    );
    return Promise.resolve({
      status: this.reachable ? "SUCCESS" : "FAILED",
      data: {
        reachable: this.reachable,
        hasSeries,
        scrapeIntervalSec: METRICS_PROVIDER.defaultScrapeLagSeconds,
      },
    });
  }
}
