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
  configHashOf,
  normalizeSnapshot,
  type SnapshotEntry,
  type SnapshotFlag,
  type SnapshotTombstone,
} from "./snapshot.js";
