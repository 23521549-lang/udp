/**
 * Một cửa cho reconciler: mọi phép đọc/ghi `rollout_sessions` và `rollout_events`
 * của Service 3. Hai file bên dưới tách theo bảng; đây chỉ gom lại để chỗ dùng
 * không phải nhớ cái nào ở đâu.
 */
export {
  claim,
  findReconcilable,
  loadSession,
  releaseLease,
  renewLease,
  setLastDecision,
  updateIfVersion,
} from "./session.repository.js";
export type { SessionPatch } from "./session.repository.js";
export {
  findUnprocessedIntent,
  markProcessed,
  recordExecution,
  recordRollbackDeployment,
} from "./event.repository.js";
