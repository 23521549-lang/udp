import {
  DEFAULT_ROLLOUT_THRESHOLDS,
  TOTAL_BUCKETS,
} from "@udp/config/constants";
import type { FlagServe } from "./evaluation.js";
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

/** Tên header HTTP (token của RFC 9110) */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

/**
 * [v4.11, Plan #51] ATTRIBUTE_SPLIT ở SERVICE_LEVEL (§7.2): request mang header này đi phiên bản mới — route của
 * Service 3 trong VirtualService (Argo Rollouts) hay `analysis.match` của Flagger. MỘT schema cho request của S1,
 * cột `rollout_sessions.traffic_match`, dây chi tiết rollout và Portal.
 */
export const trafficMatchSchema = z
  .object({
    header: z.string().regex(HEADER_NAME, "tên header không hợp lệ"),
    value: z.string().min(1).max(256),
  })
  .strict();

export type TrafficMatch = z.infer<typeof trafficMatchSchema>;

// ------------------------------------------------------------- SERVICE_LEVEL (Plan #51)

/** Tool có executor SERVICE_LEVEL — đúng hai công cụ §7.2 vẽ */
export const DELIVERY_TOOLS = ["argo-rollouts", "flagger"] as const;
export type DeliveryTool = (typeof DELIVERY_TOOLS)[number];

export const isDeliveryTool = (toolId: string): toolId is DeliveryTool =>
  (DELIVERY_TOOLS as readonly string[]).includes(toolId);

/** Tên của §9 / ADR-01 trên dây; cột database là enum `UDP_DRIVEN | TOOL_DRIVEN` */
export type ControlModeWire = "udp-driven" | "tool-driven";

export type ServiceStrategy = "CANARY" | "BLUE_GREEN" | "ATTRIBUTE_SPLIT";

/**
 * Ô nào của ma trận §7.2 chạy được với tool của environment (Plan #51 QĐ-5) — MỘT định nghĩa cho Service 1 (chốt
 * 422) và Portal (chỉ mời chọn ô làm được). `undefined` = được; chuỗi = lý do, đúng câu người dùng cần đọc để đổi
 * lựa chọn. `router` vắng (Portal chưa biết bộ định tuyến) ⇒ bỏ qua phép kiểm chỉ router quyết.
 */
export function serviceLevelIssue(
  toolId: string,
  mode: ControlModeWire,
  strategy: ServiceStrategy,
  router?: string,
): string | undefined {
  if (!isDeliveryTool(toolId)) {
    return `${toolId} chưa có executor SERVICE_LEVEL — §7.2 vẽ Argo Rollouts và Flagger`;
  }
  if (toolId === "flagger" && strategy === "BLUE_GREEN") {
    return "BLUE_GREEN ở SERVICE_LEVEL là Rollout blueGreen của Argo Rollouts (§7.2) — environment này dùng Flagger";
  }
  if (toolId === "argo-rollouts" && strategy === "ATTRIBUTE_SPLIT") {
    if (mode === "tool-driven") {
      return "ATTRIBUTE_SPLIT tool-driven là A/B của Flagger (§7.2) — với Argo Rollouts chọn udp-driven";
    }
    if (router !== undefined && router !== "istio") {
      return `ATTRIBUTE_SPLIT udp-driven định tuyến bằng VirtualService của Istio (§7.2) — router của environment là ${router}`;
    }
  }
  return undefined;
}

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

/** Một nhánh đã đo — con số và cờ có dữ liệu; `hasData = false` thì các số là 0 */
const branchSnapshotSchema = z.object({
  requestCount: z.number(),
  errorCount: z.number(),
  errorRate: z.number(),
  latencyP99Ms: z.number().optional(),
  hasData: z.boolean(),
});

/**
 * `metric_snapshot` theo đúng hình dạng `latestMetricSnapshot` của §9 — cùng một
 * hình cho `last_decision.metricSnapshot` lẫn `RolloutEvent.metric_snapshot`.
 * Service 3 ghi, Service 1 đọc để trả Portal: ở đây vì hai bên phải hiểu cùng một
 * cột JSONB (cùng lý do với `rolloutThresholdsSchema`). `queries` là MẢNG truy vấn
 * thật đã chạy (ba cho canary, hai cho baseline), `at` là epoch ms.
 */
export const metricSnapshotSchema = z.object({
  canary: branchSnapshotSchema,
  /** Không có nhánh đối chứng thì `hasData = false` — con số của canary không nói lên điều gì (§7.4) */
  baseline: branchSnapshotSchema,
  zScore: z.number().nullable(),
  queries: z.object({
    canary: z.array(z.string()),
    baseline: z.array(z.string()),
  }),
  windowSeconds: z.number(),
  at: z.number(),
});
export type MetricSnapshot = z.infer<typeof metricSnapshotSchema>;

export const DECISIONS = ["PROMOTE", "HOLD", "ROLLBACK"] as const;
export type DecisionKind = (typeof DECISIONS)[number];

/**
 * `last_decision` (§2.2, §9): tên trường `decision` là hợp đồng với Portal, nên
 * thắng chữ `kind` trong code mẫu cũ của §7.1. `at` là epoch ms của đồng hồ
 * Service 3 — cùng đồng hồ với `analysis_interval` và cửa sổ đo; Service 1 đổi
 * sang ISO khi trả Portal.
 */
export const decisionSchema = z.object({
  decision: z.enum(DECISIONS),
  reason: z.string(),
  at: z.number(),
  breach: z.boolean().default(false),
  breachStreak: z.number().int().min(0).default(0),
  /**
   * Mốc của lần vượt ngưỡng ĐƯỢC ĐẾM gần nhất (epoch ms). Chuỗi "liên tiếp" nối
   * từ mốc này, không từ `at`: nhịp đo (30s) ngắn hơn cửa sổ (60s), nên nếu nối
   * từ `at` thì mọi lần đo đều "chồng lấn" với lần ngay trước và chuỗi không bao
   * giờ tới 2 — auto-rollback không bao giờ nổ (đo được bằng test 12/09/2026).
   */
  breachAt: z.number().nullable().default(null),
  metricSnapshot: metricSnapshotSchema.nullable().default(null),
});
/** Quyết định của một vòng phân tích — chính là thứ ghi vào `last_decision` */
export type Decision = z.infer<typeof decisionSchema>;

interface WeightedVariant {
  variantId: string;
  weight: number;
}

export type CanaryPair =
  | {
      kind: "ok";
      target: WeightedVariant;
      other: WeightedVariant;
      /** Cả hai, theo ĐÚNG thứ tự của rule — thứ tự cộng dồn của `pickVariant` (I1) */
      weights: WeightedVariant[];
      /**
       * Phần trăm hiện tại của variant mục tiêu, làm tròn XUỐNG tới 2 chữ số —
       * đúng độ chính xác của `baseline_percentage NUMERIC(5,2)`. Xuống chứ không
       * làm tròn gần nhất: baseline là mốc rollback, và mốc cao hơn thực tế nghĩa
       * là rollback TĂNG phơi nhiễm của variant mới (5/100 000 ⇒ 0.01% là gấp đôi).
       */
      targetPercent: number;
    }
  | { kind: "invalid"; reason: string };

/**
 * Rule này ramp được cho variant này không (§7.2 canary FLAG_LEVEL, §16).
 *
 * MỘT định nghĩa cho hai bên: Service 1 từ chối tạo rollout bằng đúng lý do mà
 * Service 3 sẽ HOLD — hai bản lệch nhau là S1 nhận một session S3 không bao giờ
 * chạy được.
 */
export function canaryPairOf(
  serve: FlagServe,
  targetVariantId: string,
  /**
   * [v4.11, Plan #46] Variant mục tiêu ĐÃ ở 100% có hợp lệ không. Tạo rollout: không — không còn gì
   * để ramp. Đang chạy một chiến lược mà "lên 100%" chưa phải xong (ATTRIBUTE_SPLIT đứng ở 100% chờ
   * promote tay, §7.2): có.
   */
  allowFull = false,
): CanaryPair {
  if (serve.kind !== "distribution") {
    return invalid(
      "rule phục vụ thẳng một variant — chỉ ramp được rule phân phối",
    );
  }
  if (serve.weights.length !== 2) {
    return invalid(
      `rule có ${String(serve.weights.length)} variant — canary FLAG_LEVEL chỉ hỗ trợ hai nhánh (§16)`,
    );
  }
  const target = serve.weights.find((w) => w.variantId === targetVariantId);
  const other = serve.weights.find((w) => w.variantId !== targetVariantId);
  if (target === undefined || other === undefined) {
    return invalid("target_variant_id không nằm trong phân phối của rule");
  }
  if (!allowFull && target.weight >= TOTAL_BUCKETS) {
    return invalid("variant mục tiêu đã phục vụ 100% — không còn gì để ramp");
  }
  return {
    kind: "ok",
    target: { variantId: target.variantId, weight: target.weight },
    other: { variantId: other.variantId, weight: other.weight },
    weights: serve.weights.map((w) => ({
      variantId: w.variantId,
      weight: w.weight,
    })),
    // Phần trăm x 100 (đơn vị 0.01%) là số nguyên trước khi chia: không trôi số thực
    targetPercent: Math.floor((target.weight * 10_000) / TOTAL_BUCKETS) / 100,
  };
}

const invalid = (reason: string): CanaryPair => ({ kind: "invalid", reason });

/**
 * Body 200 của `POST /internal/rollouts/:id/track` và `/internal/flag-envs/:id/untrack`
 * (§9 [v4.3]). Service 2 trả, Service 1 và Service 3 đọc: một schema cho cả ba.
 */
export const trackResultSchema = z.union([
  z.object({
    flagKey: z.string(),
    environmentId: z.string(),
    /** Trạng thái SAU lần gọi */
    tracked: z.boolean(),
    changed: z.boolean(),
    /** Vì sao không đổi — vắng khi `changed` */
    skipped: z
      .enum(["already-tracked", "not-tracked", "active-session"])
      .optional(),
  }),
  /**
   * Gỡ nhãn theo config mà config không còn: không còn gì để gỡ — mục đích của
   * lời gọi đã đạt, nên 200 chứ không 404. Nhờ vậy Service 3 coi MỌI 404 là lỗi
   * thật (gọi nhầm địa chỉ, Service 2 bản cũ chưa có route).
   */
  z.object({
    tracked: z.literal(false),
    changed: z.literal(false),
    skipped: z.literal("not-found"),
  }),
]);
export type TrackResult = z.infer<typeof trackResultSchema>;

/**
 * Kết cục của `POST /internal/rollouts/:id/track` nhìn từ BÊN GỌI (S1 lúc tạo
 * rollout, S3 ở probe pha 2) — một phân loại cho cả hai [v4.4]:
 *   - `LIMIT`: 409 `TRACKED_FLAG_LIMIT` — người dùng gỡ bớt flag rồi thử lại;
 *   - `REJECTED`: S2 sống và nói không vì lý do khác (rollout đã kết thúc, 404);
 *   - `UNAVAILABLE`: mạng, hết giờ, 5xx, body sai hợp đồng — thử lại có ích.
 */
export type TrackOutcome =
  | { status: "SUCCESS"; changed: boolean }
  | { status: "LIMIT"; message: string }
  | { status: "REJECTED"; httpStatus: number; message: string }
  | { status: "UNAVAILABLE"; message: string };

/** Mã Problem Details mà Service 2 trả khi environment đã đủ flag gắn nhãn */
const TRACKED_FLAG_LIMIT = "TRACKED_FLAG_LIMIT";

/**
 * Phân loại một response HTTP đã nhận được thành `TrackOutcome` — phần THUẦN của
 * hai client; phần mạng (timeout, header, lỗi fetch ⇒ `UNAVAILABLE`) ở bên gọi.
 */
export function trackOutcomeOf(
  httpStatus: number,
  body: unknown,
): TrackOutcome {
  if (httpStatus >= 500) {
    return { status: "UNAVAILABLE", message: `HTTP ${String(httpStatus)}` };
  }
  if (httpStatus >= 400) {
    const { code, detail } = problemFieldsOf(body);
    return code === TRACKED_FLAG_LIMIT
      ? { status: "LIMIT", message: detail }
      : { status: "REJECTED", httpStatus, message: detail };
  }
  const parsed = trackResultSchema.safeParse(body);
  return parsed.success
    ? { status: "SUCCESS", changed: parsed.data.changed }
    : {
        status: "UNAVAILABLE",
        message: "Service 2 trả body không đúng hợp đồng track",
      };
}

function problemFieldsOf(body: unknown): { code?: string; detail: string } {
  if (typeof body !== "object" || body === null) return { detail: "" };
  const { code, detail } = body as { code?: unknown; detail?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    detail: typeof detail === "string" ? detail : "",
  };
}

/**
 * Bốn ý định người dùng ghi được (§7.6) — ba giá trị còn lại của enum
 * `RolloutAction` là event thực thi của S3. S1 nhận, S3 đọc: một danh sách
 * (package này không phụ thuộc `@udp/db`, nên S3 khẳng định nó là tập con của
 * enum bằng `satisfies` ở phía mình).
 */
export const INTENT_ACTIONS = [
  "PAUSE",
  "RESUME",
  "PROMOTE",
  "ROLLBACK",
] as const;
export type IntentAction = (typeof INTENT_ACTIONS)[number];
