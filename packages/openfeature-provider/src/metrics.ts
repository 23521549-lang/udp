import { Histogram, register, type Registry } from "prom-client";
import { requestStore, type RequestLabels } from "./labels.js";

/**
 * `udpMetricsMiddleware` — histogram HTTP có nhãn `ff` (§6.6, C1) [v4.7]. Subpath
 * riêng (`udp-openfeature/metrics`): chỉ ứng dụng dùng nó mới cần
 * prom-client, và prom-client là PEER — một bản riêng của provider sẽ đăng ký
 * histogram vào registry KHÁC với `/metrics` của ứng dụng, series biến mất im lặng.
 *
 * Mỗi request ghi MỘT series tổng `ff=""` CỘNG mỗi tracked flag đã đánh giá một
 * series `ff="<flagKey>=<variant>"` (key thô) — cộng thêm, không nhân chéo. Truy vấn
 * phân tích không nhắm nhánh nào lọc `ff=""` (§7.4), nên không đếm lặp.
 */

export const REQUEST_DURATION_METRIC = "http_server_request_duration_seconds";

/** Nhãn phát ra — hợp đồng với truy vấn metrics của nền tảng (§7.4) */
export const REQUEST_DURATION_LABELS = [
  "service_name",
  "service_version",
  "http_route",
  "http_request_method",
  "http_response_status_code",
  "ff",
] as const;

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/** Route không khớp — KHÔNG BAO GIỜ URL thô (mỗi id một series: cardinality nổ) */
export const UNMATCHED_ROUTE = "UNMATCHED";

/** Request bị client huỷ trước khi xong — quy ước của nginx */
const CLIENT_CLOSED = "499";

/** Kiểu tối thiểu của request/response — không kéo `express` vào */
export interface MetricsRequest {
  method: string;
  baseUrl?: string;
  route?: { path?: unknown };
}
export interface MetricsResponse {
  statusCode: number;
  headersSent: boolean;
  on(event: "finish" | "close", listener: () => void): unknown;
}

export interface UdpMetricsOptions {
  /** Registry của ứng dụng; mặc định registry mặc định của prom-client */
  registry?: Registry;
  /** Mặc định `OTEL_SERVICE_NAME`; PHẢI khớp `workloadName` mà Service 3 truy vấn */
  serviceName?: string;
  /** Mặc định `service.version` trong `OTEL_RESOURCE_ATTRIBUTES` */
  serviceVersion?: string;
  /** Mẫu route của request; mặc định `req.baseUrl + req.route.path` */
  routeOf?: (req: MetricsRequest) => string | undefined;
}

/** `service.version` trong `OTEL_RESOURCE_ATTRIBUTES` (`k=v,k=v`, giá trị percent-encoded) */
function resourceAttribute(name: string): string | undefined {
  for (const pair of (process.env["OTEL_RESOURCE_ATTRIBUTES"] ?? "").split(
    ",",
  )) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    } catch {
      return pair.slice(eq + 1).trim();
    }
  }
  return undefined;
}

const defaultRouteOf = (req: MetricsRequest): string | undefined =>
  typeof req.route?.path === "string"
    ? `${req.baseUrl ?? ""}${req.route.path}`
    : undefined;

/**
 * Lấy lại histogram đã đăng ký — tạo middleware hai lần không được ném lúc khởi
 * động. Nhưng tên này là tên CHUẨN của OTel semconv: ứng dụng có thể đã tự đăng ký
 * nó với bộ nhãn khác (express-prom-bundle, histogram tự viết). Dùng lại một
 * histogram thiếu nhãn `ff` thì mọi lần ghi đều ném rồi bị nuốt — không series nào,
 * mọi rollout FLAG_LEVEL hết hạn mà không một dòng log. Nên kiểm và NÉM rõ lúc dựng.
 */
function histogramOf(registry: Registry): Histogram {
  const existing = registry.getSingleMetric(REQUEST_DURATION_METRIC);
  if (existing !== undefined) {
    const labels = new Set(
      (existing as unknown as { labelNames?: readonly string[] }).labelNames,
    );
    const missing = REQUEST_DURATION_LABELS.filter((l) => !labels.has(l));
    if (!(existing instanceof Histogram) || missing.length > 0) {
      throw new Error(
        `${REQUEST_DURATION_METRIC} đã được đăng ký với kiểu hoặc bộ nhãn khác` +
          (missing.length > 0 ? ` (thiếu ${missing.join(", ")})` : "") +
          " — truyền `registry` riêng cho udpMetricsMiddleware hoặc bỏ metric trùng tên",
      );
    }
    return existing;
  }
  return new Histogram({
    name: REQUEST_DURATION_METRIC,
    help: "Thời gian xử lý request HTTP (giây), gắn nhãn nhánh flag ff (§6.6)",
    labelNames: [...REQUEST_DURATION_LABELS],
    buckets: BUCKETS,
    registers: [registry],
  });
}

export function udpMetricsMiddleware(
  options: UdpMetricsOptions = {},
): (req: MetricsRequest, res: MetricsResponse, next: () => void) => void {
  const histogram = histogramOf(options.registry ?? register);
  const serviceName =
    options.serviceName ?? process.env["OTEL_SERVICE_NAME"] ?? "unknown";
  const serviceVersion =
    options.serviceVersion ?? resourceAttribute("service.version") ?? "unknown";
  const routeOf = options.routeOf ?? defaultRouteOf;

  return (req, res, next) => {
    // Store giữ trong CLOSURE: listener của `finish`/`close` chạy trong async
    // context của nơi phát sự kiện, không phải nơi `run` — `getStore()` ở đó có
    // thể là `undefined` (và `getStore()!` của bản §6.6 cũ làm sập ứng dụng khách)
    const labels: RequestLabels = { flags: new Map() };
    const started = process.hrtime.bigint();
    let recorded = false;
    const record = (status: string): void => {
      if (recorded) return;
      recorded = true;
      try {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const base = {
          service_name: serviceName,
          service_version: serviceVersion,
          http_route: routeOf(req) ?? UNMATCHED_ROUTE,
          http_request_method: req.method,
          http_response_status_code: status,
        };
        histogram.observe({ ...base, ff: "" }, seconds);
        for (const [flagKey, variant] of labels.flags) {
          histogram.observe({ ...base, ff: `${flagKey}=${variant}` }, seconds);
        }
      } catch {
        // đo lường không bao giờ được làm sập ứng dụng khách (I33)
      }
    };
    // `finish` luôn kéo theo `close`; ghi ĐÚNG MỘT lần. Client huỷ TRƯỚC khi header
    // được gửi ⇒ 499; header đã gửi (vd stream 200 bị cắt giữa chừng) ⇒ giữ status
    // server đã trả — đó là thứ client đã nhận
    res.on("finish", () => record(String(res.statusCode)));
    res.on("close", () =>
      record(res.headersSent ? String(res.statusCode) : CLIENT_CLOSED),
    );
    requestStore.run(labels, next);
  };
}
