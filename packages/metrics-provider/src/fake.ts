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
  /** `<namespace>/<workload>` → số request trong cửa sổ probe (pha 1) */
  private readonly workloads = new Map<string, number>();
  private reachable = true;
  private queryFailing = false;

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

  /** Probe pha 1 [v4.4]: workload có lưu lượng trong cửa sổ probe */
  setWorkload(namespace: string, workloadName: string, requests = 1): this {
    this.workloads.set(`${namespace}/${workloadName}`, requests);
    return this;
  }

  /** Nguồn sống nhưng truy vấn hỏng — `probe()` báo `queryFailed` */
  setQueryFailing(failing: boolean): this {
    this.queryFailing = failing;
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

  /**
   * Cùng hai pha với Prometheus thật [v4.4]: có `flagKey` thì theo nhánh của
   * flag, không thì theo workload; và phải có LƯU LƯỢNG (`requests > 0`), không
   * chỉ có khoá.
   */
  probe(t: MetricTarget): Promise<AdapterResult<ProbeOutcome>> {
    const failed = !this.reachable || this.queryFailing;
    const hasSeries =
      !failed &&
      (t.flagKey !== undefined
        ? [...this.branches].some(
            ([k, b]) => k.startsWith(`${t.flagKey ?? ""}=`) && b.requests > 0,
          )
        : t.version !== undefined
          ? (this.branches.get(t.version)?.requests ?? 0) > 0
          : (this.workloads.get(`${t.namespace}/${t.workloadName}`) ?? 0) > 0);
    return Promise.resolve({
      status: failed ? "FAILED" : "SUCCESS",
      data: {
        reachable: this.reachable,
        hasSeries,
        queryFailed: this.reachable && this.queryFailing,
        scrapeIntervalSec: METRICS_PROVIDER.defaultScrapeLagSeconds,
        scrapeIntervalSource: "workload",
      },
    });
  }
}
