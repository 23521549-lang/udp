import { DEFAULT_ROLLOUT_THRESHOLDS } from "@udp/config/constants";
import { z } from "zod";

/**
 * Ngưỡng của một `RolloutSession` (§2.2 `thresholds`, §7.4).
 *
 * Ở đây vì HAI bên cùng cần đúng một hình dạng: Service 1 ghi cột JSONB này khi
 * tạo session (Luồng 5), Service 3 đọc nó ở mỗi vòng phân tích. Hai schema ở hai
 * service là hai cách hiểu về cùng một cột, và cách hiểu lệch nhau chỉ lộ ra
 * khi một rollout ra quyết định sai.
 *
 * Mọi trường tuỳ chọn với mặc định từ `DEFAULT_ROLLOUT_THRESHOLDS`: fixture hiện
 * có ghi `{}` và §7.4 nói "khi người dùng không chỉ định". `.strict()` để một
 * khoá gõ sai (`errorRates`) không âm thầm rơi về mặc định.
 */
export const rolloutThresholdsSchema = z
  .object({
    /** Tỉ lệ lỗi tuyệt đối, 0..1 */
    errorRate: z
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_ROLLOUT_THRESHOLDS.errorRate),
    /** Hệ số so với baseline (k); null/thiếu = không dùng ngưỡng tương đối */
    relativeErrorRate: z
      .number()
      .positive()
      .nullable()
      .default(DEFAULT_ROLLOUT_THRESHOLDS.relativeErrorRate),
    latencyP99Ms: z
      .number()
      .positive()
      .default(DEFAULT_ROLLOUT_THRESHOLDS.latencyP99Ms),
    /** Số lỗi tuyệt đối tối thiểu để một breach tuyệt đối có nghĩa (§7.5 vấn đề 5) */
    minErrors: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_ROLLOUT_THRESHOLDS.minErrors),
    /** Số lần đo LIÊN TIẾP vượt ngưỡng trước khi rollback (§7.5 vấn đề 2) */
    maxConsecutiveBreaches: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_ROLLOUT_THRESHOLDS.maxConsecutiveBreaches),
  })
  .strict();

export type RolloutThresholds = z.infer<typeof rolloutThresholdsSchema>;

/**
 * Tên metric hợp lệ của Prometheus (`[a-zA-Z_:][a-zA-Z0-9_:]*`). Chốt ở biên
 * ghi (S1) VÀ ở nơi ghép PromQL (`@udp/metrics-provider`): `metric_queries` là dữ
 * liệu người dùng, một giá trị như `x_count{}) or vector(0) #` sẽ viết lại cả
 * truy vấn nếu chỉ tin một bên.
 */
export const PROMETHEUS_METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/**
 * `RolloutSession.metric_queries` (§2.2, §7.4 "Override"): app không theo OTel
 * semconv thì khai tên metric gốc của nó; các truy vấn §7.4 ghép từ đó
 * (`<base>_count`, `<base>_bucket`). `.strict()` vì một khoá gõ sai không được
 * âm thầm rơi về mặc định.
 */
export const metricQueriesSchema = z
  .object({
    metricBase: z.string().regex(PROMETHEUS_METRIC_NAME),
  })
  .strict();

export type MetricQueries = z.infer<typeof metricQueriesSchema>;
