/**
 * Lõi đánh giá flag — dùng chung giữa Service 2 và SDK chạy trong ứng dụng khách.
 *
 * §6.5 nói rõ vì sao nó phải là package chứ không phải thư mục trong service:
 * "package `@udp/flag-evaluator` được SDK server (local) và Service 2 (OFREP,
 * /internal/flags/:id/evaluate, Flag Evaluation Tester) dùng chung". Đó là điều
 * kiện CẤU TRÚC của bất biến I26 — nếu provider tự viết lại hàm đánh giá thì I26
 * chỉ còn đúng nhờ may mắn.
 */

export { bucketOf, type BucketInput } from "./hash.js";
export { pickVariant, type VariantPick } from "./distribution.js";
export {
  canonicalJson,
  compareCodeUnits,
  configHashOf,
  normalizeSnapshot,
  type Snapshot,
  type SnapshotEntry,
  type SnapshotFlag,
  type SnapshotRule,
  type SnapshotSegment,
  type SnapshotTombstone,
} from "./snapshot.js";
export {
  etagOf,
  SDK_STREAM_EVENTS,
  type SdkConfigResponse,
  type SdkStreamChange,
  type SdkStreamDelta,
  type SdkStreamFlagAbsentChange,
  type SdkStreamEventName,
  type SdkStreamFlagChange,
  type SdkStreamSegmentAbsentChange,
  type SdkStreamSegmentChange,
  type SdkStreamTrackedFlagsChange,
} from "./sdk-wire.js";
export {
  EVALUATOR_SEMANTICS_VERSION,
  evaluate,
  evaluateAll,
  type EvaluateOptions,
} from "./evaluate.js";
export { prepareSnapshot, type PreparedSnapshot } from "./prepare.js";
export {
  fromOfrep,
  ofrepFlagNotFound,
  ofrepVisible,
  toOfrep,
} from "./ofrep.js";
export {
  applyChange,
  applyDelta,
  hashVerdict,
  parseSdkConfig,
  parseSdkDelta,
  type DeltaOutcome,
  type HashVerdict,
} from "./changefeed.js";
