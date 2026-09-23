/**
 * `@udp/flag-snapshot` — snapshot cấu hình flag của MỘT environment ở hình dạng
 * dây (§9), `config_hash` và delta outbox tính từ nó (§8.4 bước 3–4).
 *
 * Vì sao là package riêng chứ không nằm trong Service 2: đường lan truyền của
 * ADR-05 có HAI writer — Service 2 cho mọi thay đổi cấu hình, và Service 3 ở
 * nhánh kill-switch (§7.6, I30). `config_hash` là hợp đồng liên tiến trình (I15c:
 * "cùng từng bit"), nên hai writer phải tính nó bằng đúng một đoạn code. Hai bản
 * chép là I15c hỏng bằng cấu trúc, không cần bug nào.
 *
 * Hướng phụ thuộc: `db`, `flag-evaluator`, `shared-types` → package này → hai
 * service. `@udp/db` giữ kỷ luật transaction và không biết snapshot là gì
 * (`writeWithOutbox` nhận `stateOf` từ bên gọi), nên không có vòng.
 */
export {
  segmentPayloadBytesOf,
  segmentStateFor,
  snapshotFromRow,
  snapshotOf,
  stateFor,
  trackedStateOf,
  unchangedStateOf,
} from "./snapshot-builder.js";
export {
  snapshotRowOf,
  snapshotRowSchema,
  type FlagRow,
  type SnapshotOptions,
  type SnapshotRow,
} from "./snapshot-row.js";
