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
 *   (`CapabilityDeclaration`, `CapabilityBinding` đã vào `./capability` ở Plan #24:
  chúng là dữ liệu THUẦN và Portal cần chúng, khác `ResolvedCredential` bị loại vì
  có hành vi.)
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
  Evaluation,
  EvaluationContext,
  EvaluationReason,
  FlagMetadata,
  FlagServe,
  FlagServeWire,
  ResolutionDetails,
  ResolutionErrorCode,
  ResolutionReason,
} from "./evaluation.js";
export {
  EVALUATION_REASONS,
  RESOLUTION_ERROR_CODES,
  canonicalizeServe,
  distributionWeightsDbSchema,
  flagServeDbSchema,
  flagServeUnion,
  flagServeWireSchema,
  flagServeWireUnion,
} from "./evaluation.js";

export type { AdapterOperationStatus, AdapterResult } from "./adapter.js";

export type {
  CapabilityAnyOf,
  CapabilityBinding,
  CapabilityDeclaration,
  CapabilityId,
  CapabilityProvision,
  CapabilityRequirement,
  CapabilityRequires,
} from "./capability.js";
export { CAPABILITY_IDS, isAnyOf } from "./capability.js";
export {
  canaryPairOf,
  DECISIONS,
  INTENT_ACTIONS,
  decisionCauseSchema,
  decisionDetailSchema,
  decisionSchema,
  metricQueriesSchema,
  metricSnapshotSchema,
  PROMETHEUS_METRIC_NAME,
  rolloutThresholdsSchema,
  trackOutcomeOf,
  trackResultSchema,
  trafficMatchSchema,
  DELIVERY_TOOLS,
  isDeliveryTool,
  serviceLevelIssue,
} from "./rollout.js";
export type {
  CanaryPair,
  Decision,
  DecisionCause,
  DecisionDetail,
  DecisionKind,
  IntentAction,
  MetricQueries,
  MetricSnapshot,
  RolloutThresholds,
  TrackOutcome,
  TrackResult,
  TrafficMatch,
  ControlModeWire,
  DeliveryTool,
  ServiceStrategy,
} from "./rollout.js";
export type { ConfigChangeNotice, ConfigChangeType } from "./change-feed.js";

export { FLAG_TYPES, FLAG_VALUE_SCHEMAS } from "./flag-value.js";

export type { RuleType } from "./condition.js";
export {
  ATTRIBUTE_OPERATORS,
  attributeConditionSchema,
  compareSemver,
  conditionIssue,
  conditionSchemas,
  parseSemver,
  readAttributeConditionSchema,
  readConditionSchemas,
  readSegmentConditionsSchema,
  regexSyntaxIssue,
  segmentConditionsSchema,
  RULE_TYPES,
} from "./condition.js";
export type {
  AttributeCondition,
  AttributeOperator,
  SegmentConditions,
  Semver,
} from "./condition.js";
export {
  evaluationContextSchema,
  ofrepContextIssue,
  ofrepRequestSchema,
} from "./ofrep.js";
export type {
  OfrepBulkFailure,
  OfrepBulkResponse,
  OfrepEvaluationErrorCode,
  OfrepFailure,
  OfrepFlagNotFound,
  OfrepMetadata,
  OfrepReason,
  OfrepSuccess,
} from "./ofrep.js";
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
export {
  createFlagFields,
  createFlagRefine,
  flagKeySchema,
  replaceRulesFields,
  replaceRulesRefine,
  replaceVariantsFields,
  replaceVariantsRefine,
  ruleInputSchema,
  updateEnvConfigFields,
  updateEnvConfigRefine,
  updateFlagFields,
  updateFlagRefine,
  testerResultSchema,
} from "./flag-api.js";
export type {
  TesterResult,
  CreateFlagFields,
  ReplaceRulesFields,
  ReplaceVariantsFields,
  UpdateEnvConfigFields,
  UpdateFlagFields,
} from "./flag-api.js";
export {
  sdkStatsReportSchema,
  STATS_VARIANT,
  statsVariantOf,
} from "./sdk-stats.js";
export type { SdkStatsReport } from "./sdk-stats.js";
export {
  archiveStatusSchema,
  daysBefore,
  flagStatsQueryFields,
  flagStatsQueryRefine,
  flagStatsResponseSchema,
  flagStatsSummarySchema,
  hourFloor,
  hoursAfter,
  hoursBefore,
  STALE_CATEGORIES,
  staleFlagsQuerySchema,
  staleFlagsResponseSchema,
  STATS_GRANULARITIES,
  tzSchema,
} from "./flag-stats.js";
export type {
  ArchiveStatus,
  FlagStatsQuery,
  FlagStatsResponse,
  FlagStatsSummary,
  StaleCategory,
  StaleFlagsQuery,
  StaleFlagsResponse,
  StatsGranularity,
} from "./flag-stats.js";
export { createSegmentFields, updateSegmentFields } from "./segment-api.js";
export type {
  CreateSegmentFields,
  UpdateSegmentFields,
} from "./segment-api.js";

export {
  BUILD_LANGUAGES,
  BUILD_STRATEGIES,
  BUILD_TEXT_RULES,
  BUILDPACKS_LANGUAGES,
  buildIdentitySchema,
  buildSettingsSchema,
  buildSigningSchema,
  buildTestSettingSchema,
  DEFAULT_BUILD_SETTINGS,
  identityLineSchema,
  isSafeBuildPath,
  kmsCloudOf,
  oidcRequiredSchema,
  rebaseScheduleOf,
  SIGNATURE_REJECTIONS,
  signingEnforceSchema,
  signingKeySchema,
  TRUSTED_DEPLOY_REJECTIONS,
  TRUSTED_DEPLOY_RETRYABLE,
} from "./build.js";
export type {
  BuildIdentityInput,
  BuildLanguage,
  BuildSettings,
  BuildStrategyName,
  IdentityLine,
  RebaseSchedule,
  SignatureRejection,
  SigningKey,
  TrustedDeployRejection,
} from "./build.js";
