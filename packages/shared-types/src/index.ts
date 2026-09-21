/**
 * `@udp/shared-types` — hợp đồng mà nhiều service phải hiểu GIỐNG HỆT nhau.
 *
 * Nguyên tắc của package này: chỉ chứa thứ mà **từ hai bên trở lên** cùng cần.
 * Type chỉ một service dùng thì thuộc về service đó, không thuộc về đây.
 *
 * Hai ràng buộc bắt buộc — được CƯỠNG CHẾ bởi test `package-boundaries` trong
 * `@udp/design-lint`, không chỉ ghi ở đây. Một lần đã suýt xoá file này vì
 * "không ai import barrel"; ràng buộc nằm trong chú thích thì mất theo file,
 * ràng buộc nằm trong test thì không.
 *
 *   1. KHÔNG import `@udp/db`, kể cả chỉ để lấy enum của Prisma. Đó là chỗ duy
 *      nhất tạo được vòng phụ thuộc `db → shared-types → db`.
 *   2. Chỉ import `@udp/config/constants` (subpath thuần), KHÔNG import
 *      `@udp/config` — entry chính chạy env validation lúc nạp module và ném lỗi
 *      nếu thiếu biến.
 *
 * `AdapterResult` (§4.1) vào đây ở Plan #16 cùng `@udp/metrics-provider` — người
 * tiêu thụ đầu tiên là `probe()` của MetricsProvider. Chưa có, hoãn có địa chỉ:
 *   - `ResolvedCredential` (§4.1) → plan Cloud Adapter đầu tiên. Nó không phải
 *     type thuần: có `dispose()` và bị cấm serialize (I12, I24), nên đặt vào một
 *     package "chỉ có type" là mất hợp đồng.
 *   - `CapabilityDeclaration`, `CapabilityBinding` (§5.3) → plan Domain Adapter.
 *
 * Lý do hoãn: chưa có adapter nào tồn tại. Type viết trước khi có người tiêu thụ
 * gần như chắc chắn sai theo cách không phát hiện được, và lúc sửa thì đã bị
 * import ở nhiều nơi.
 */

export type {
  ErrorCode,
  ErrorCodeSpec,
  FieldError,
  ProblemDetails,
  SuggestedAction,
} from "./problem.js";
export { ERROR_CATALOG } from "./problem.js";

export type {
  EvaluationContext,
  FlagMetadata,
  FlagServe,
  FlagServeWire,
  ResolutionDetails,
  ResolutionErrorCode,
  ResolutionReason,
} from "./evaluation.js";
export {
  canonicalizeServe,
  distributionWeightsDbSchema,
  flagServeDbSchema,
  flagServeUnion,
  flagServeWireSchema,
  flagServeWireUnion,
} from "./evaluation.js";

export type { AdapterOperationStatus, AdapterResult } from "./adapter.js";
export {
  metricQueriesSchema,
  PROMETHEUS_METRIC_NAME,
  rolloutThresholdsSchema,
} from "./rollout.js";
export type { MetricQueries, RolloutThresholds } from "./rollout.js";
export type { ConfigChangeNotice, ConfigChangeType } from "./change-feed.js";

export { FLAG_TYPES, FLAG_VALUE_SCHEMAS } from "./flag-value.js";

export type { RuleType } from "./condition.js";
export {
  ATTRIBUTE_OPERATORS,
  conditionIssue,
  conditionSchemas,
  RULE_TYPES,
} from "./condition.js";
export {
  CONFIG_CHANGE_CHANNEL,
  CONFIG_CHANGE_TYPES,
  formatConfigChangeNotice,
  parseConfigChangeNotice,
} from "./change-feed.js";
export {
  formatRolloutIntentNotice,
  parseRolloutIntentNotice,
  ROLLOUT_INTENT_CHANNEL,
} from "./rollout-intent.js";
export type { RolloutIntentNotice } from "./rollout-intent.js";
