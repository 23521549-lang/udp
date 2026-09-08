/**
 * `@udp/shared-types` — hợp đồng mà nhiều service phải hiểu GIỐNG HỆT nhau.
 *
 * Nguyên tắc của package này: chỉ chứa thứ mà **từ hai bên trở lên** cùng cần.
 * Type chỉ một service dùng thì thuộc về service đó, không thuộc về đây.
 *
 * Hai ràng buộc bắt buộc:
 *
 *   1. KHÔNG import `@udp/db`, kể cả chỉ để lấy enum của Prisma. Đó là chỗ duy
 *      nhất tạo được vòng phụ thuộc `db → shared-types → db`.
 *   2. Chỉ import `@udp/config/constants` (subpath thuần), KHÔNG import
 *      `@udp/config` — entry chính chạy env validation lúc nạp module và ném lỗi
 *      nếu thiếu biến.
 *
 * Chưa có ở vòng 1, hoãn có địa chỉ:
 *   - `AdapterResult`, `ResolvedCredential` (§4.1) → plan Cloud Adapter đầu tiên.
 *     `ResolvedCredential` không phải type thuần: nó có `dispose()` và bị cấm
 *     serialize (I12, I24), nên đặt vào một package "chỉ có type" là mất hợp đồng.
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
  ResolutionDetails,
  ResolutionErrorCode,
  ResolutionReason,
} from "./evaluation.js";
export { flagServeDbSchema, flagServeUnion } from "./evaluation.js";
