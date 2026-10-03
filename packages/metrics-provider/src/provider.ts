import type { AdapterResult } from "@udp/shared-types";

/**
 * Trừu tượng hoá nguồn metrics (§5.4) — nền của auto-rollback theo flag (C1).
 *
 * Auto-rollback không được phép chỉ hoạt động với Prometheus: developer chọn
 * Datadog/VictoriaMetrics thì Service 3 vẫn phải ra quyết định bằng cùng một
 * `decide()` (§7.1). Hợp đồng này là ranh giới đó. Hai bên dùng nó:
 *   - Service 1 gọi `probe()` lúc tạo rollout (fail sớm, §7.4);
 *   - Service 3 gọi phần còn lại ở mỗi vòng phân tích.
 */

export interface MetricTarget {
  namespace: string;
  /** Tên workload — luôn có, vì mọi truy vấn §7.4 lọc `service_name` */
  workloadName: string;
  /** SERVICE_LEVEL: so sánh theo version của pod */
  version?: string;
  /** FLAG_LEVEL: so sánh theo nhánh feature flag — nền tảng của C1 (§6.6) */
  flagKey?: string;
  variantKey?: string;
}

export interface MetricSample {
  value: number;
  /** Truy vấn THẬT đã chạy — ghi vào `RolloutEvent.metric_snapshot` để tái lập được */
  query: string;
  windowSeconds: number;
  /**
   * `false` khi nguồn metrics không trả đủ dữ liệu — KHÔNG được coi là 0.
   * Prometheus chết mà quy ra "không lỗi" là canary tự lên 100% đúng lúc hệ
   * thống hỏng nặng nhất (I7).
   */
  hasData: boolean;
}

/**
 * [Plan #53] Ba chuỗi RED của trang Giám sát: lưu lượng (request/giây), tỉ lệ lỗi 5xx (0..1),
 * p99 độ trễ (mili giây).
 */
export type SeriesKind = "requestRate" | "errorRatio" | "latencyP99";

export interface SeriesWindow {
  /** Độ dài khoảng nhìn lại, giây */
  rangeSec: number;
  /** Bước giữa hai điểm, giây */
  stepSec: number;
  /** Mốc cuối (mặc định: bây giờ) — test truyền vào để tất định */
  end?: Date;
}

export interface SeriesPoint {
  /** Epoch giây, chia hết cho bước */
  t: number;
  /** `null` = KHÔNG có dữ liệu ở mốc này — không bao giờ được đọc là 0 (I7) */
  v: number | null;
}

export interface MetricSeries {
  kind: SeriesKind;
  unit: "rps" | "ratio" | "ms";
  points: SeriesPoint[];
  /** Truy vấn thật đã chạy — để tái lập, như `MetricSample.query` */
  query: string;
}

/**
 * Scrape interval đo từ đâu: từ chính series của workload (tốt nhất), từ
 * `/api/v1/targets` (lớn nhất trên MỌI target — thường bi quan: một exporter 60s
 * kéo cả cụm lên 60s), hay không đo được (bên gọi rơi về mặc định).
 */
export type ScrapeIntervalSource = "workload" | "global" | "assumed";

export interface ProbeOutcome {
  reachable: boolean;
  /**
   * [v4.4] Có LƯU LƯỢNG cho target trong `METRICS_PROVIDER.probeWindowSeconds`
   * gần nhất — series phải tăng, không chỉ tồn tại: counter giữ series của lần
   * trước tới khi process khởi động lại.
   */
  hasSeries: boolean;
  /**
   * [v4.4] Nguồn sống nhưng truy vấn hỏng (5xx, hết giờ, trả sai hình). Khác hẳn
   * "không có series": cái sau là việc của người dùng (cài middleware), cái này
   * là việc của người vận hành — Service 1 trả 503, không trả 422.
   */
  queryFailed: boolean;
  /** Để validator ép `metric_window ≥ 4 × scrape` (§7.4) */
  scrapeIntervalSec?: number;
  scrapeIntervalSource: ScrapeIntervalSource;
}

export interface MetricsProvider {
  /** "prometheus", "datadog", "victoria-metrics" */
  readonly providerId: string;
  /** Version của capability `metrics.query` mà provider này thoả (PromQL = 2.x) */
  readonly capabilityVersion: string;
  /**
   * [v4.2] Độ trễ scrape mà `decide()` phải chờ sau mỗi bậc trước khi đo (§7.1:
   * `now < lastStepAt + window + provider.scrapeLagSeconds` ⇒ HOLD). Thuộc về
   * nguồn metrics, không thuộc session.
   */
  readonly scrapeLagSeconds: number;

  errorRate(t: MetricTarget, windowSec: number): Promise<MetricSample>;
  latencyP99(t: MetricTarget, windowSec: number): Promise<MetricSample>;
  requestCount(t: MetricTarget, windowSec: number): Promise<MetricSample>;
  /** Số request lỗi tuyệt đối — cần cho `minErrors` và z-test (§7.4) */
  errorCount(t: MetricTarget, windowSec: number): Promise<MetricSample>;
  /** Business metric tuỳ biến — mở đường cho §17 */
  custom(
    query: string,
    t: MetricTarget,
    windowSec: number,
  ): Promise<MetricSample>;
  /**
   * Nguồn có sống và target có lưu lượng không — hai pha [v4.4] (§7.4):
   *   - không `flagKey`: theo WORKLOAD — Service 1 lúc tạo rollout (middleware đã
   *     xuất metric cho đúng `service_name`/`namespace` chưa);
   *   - có `flagKey`: theo nhãn `ff` của flag (không theo variant — variant mới
   *     chưa có traffic) — Service 3 trước bậc đầu, SAU khi flag đã được track.
   *     Hook chỉ gắn nhãn cho flag đã track (§6.6), nên pha này chạy trước
   *     `track` thì không bao giờ thấy gì.
   */
  probe(t: MetricTarget): Promise<AdapterResult<ProbeOutcome>>;
}

/**
 * [Plan #53 QĐ-4] Provider trả được CHUỖI THỜI GIAN — mọi nguồn thật của gói (Prometheus, Datadog,
 * New Relic, Dynatrace) và bản giả. Tách khỏi `MetricsProvider` (phân tách interface): Service 3 chỉ
 * cần phép đo tức thời cho gate canary và đo nhờ qua Service 1 (`RemoteMetricsProvider`), nên nó
 * không phải hiện thực một hàm nó không bao giờ gọi.
 */
export interface MetricsSeriesProvider extends MetricsProvider {
  /**
   * Chuỗi thời gian RED của một target — trang Giám sát của Service 1.
   *
   *  - **Lưới:** `points` phủ ĐÚNG các mốc từ `⌊(end − rangeSec)/stepSec⌋·stepSec` tới
   *    `⌊end/stepSec⌋·stepSec`, mỗi bước một điểm, tăng dần (`seriesGrid`). Mốc nguồn không
   *    trả là `v: null`.
   *  - **`null` là KHÔNG có dữ liệu** (I7: "không dữ liệu ⇒ không bao giờ là 0"). `requestRate`
   *    là 0 chỉ khi nguồn THẬT trả 0; `errorRatio` ở bước không có request là `null` (0/0),
   *    không phải 0; `NaN`/`±Inf` của nguồn thành `null`. Không có series lỗi nào KHI có lưu
   *    lượng là tỉ lệ 0 — cùng luật với `errorRate`.
   *  - **Đơn vị:** `requestRate` request/giây (`rps`), `errorRatio` 0..1 (`ratio`),
   *    `latencyP99` mili giây (`ms`) — nguồn trả giây thì provider đổi, như `latencyP99`.
   *  - **Mỗi điểm nhìn LÙI:** điểm ở mốc `t` đo khoảng ngay trước `t` — PromQL `rate(…[w])`
   *    với `w = max(stepSec, 60)` (`seriesRateWindowSec`); nguồn SaaS lấy ô `(t − step, t]`.
   *  - **Lọc:** cùng matcher với các truy vấn tức thời §7.4 (namespace + workload, `version`
   *    nếu có, series tổng `ff=""` khi không nhắm nhánh flag).
   *  - **Hàng rào:** `RangeError` khi quá `MAX_SERIES_STEPS` bước hay cửa sổ không phải số
   *    giây nguyên dương.
   *  - **Hỏng** (HTTP lỗi, hết giờ, trả sai hình): ném `MetricsQueryError` — Service 1 trả
   *    503. KHÔNG bao giờ trả một chuỗi toàn 0 thay cho lỗi.
   */
  series(
    kind: SeriesKind,
    target: MetricTarget,
    window: SeriesWindow,
  ): Promise<MetricSeries>;
}
