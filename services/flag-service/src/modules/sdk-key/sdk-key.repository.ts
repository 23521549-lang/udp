import type { Prisma } from "@udp/db";
import type { SdkKeyType } from "@udp/db";

/**
 * Đọc và ghi `sdk_keys` cho hai route nội bộ (§3.2, L7) [v4.9].
 *
 * `udp_s2` có đủ bốn quyền trên bảng này (I22, ma trận writer), còn `udp_s1` chỉ
 * SELECT — nên đường GHI khoá bắt buộc nằm ở đây, không phải ở Service 1. R25 (a)
 * mô tả đúng cái bẫy: đặt service ghi khoá ở Service 1 thì mọi lời gọi ra `42501`
 * lúc chạy, và "sửa" nó bằng một lệnh GRANT là phá ma trận writer.
 *
 * Mọi hàm nhận `tx`: chúng chạy trong transaction tạo khoá (dưới advisory lock
 * theo environment) hoặc trong `mutate` của `writeConfigChange` khi thu hồi. Một
 * phép đếm quota chạy ngoài khoá là đúng khe hở mà AC-5.1 bắn vào — 25 lời gọi
 * đồng thời cùng đọc 19 rồi cùng ghi.
 */

/**
 * Tuần tự hoá mọi lần TẠO khoá của một environment (V4, V5, AC-5.1).
 *
 * Advisory lock chứ không `SELECT … FOR UPDATE` trên hàng `environments`: tạo
 * khoá KHÔNG đổi nội dung cấu hình, nên nó không đi qua `writeWithOutbox` và
 * không có quyền chạm `config_version`. Khoá hàng environment ở đây sẽ xếp hàng
 * cùng mọi lần ghi flag và cả kill-switch của Service 3 — trả một cái giá của
 * ADR-05 mà không dùng gì của nó. Advisory lock hết hiệu lực khi transaction kết
 * thúc (`_xact_`), nên không có đường nào rò một khoá không được nhả.
 *
 * `hashtextextended(uuid, 0)` cho một `bigint` tất định từ id — cùng khuôn
 * `insertIntent` của Service 1 đã dựng cho sổ intent rollout. Va chạm hash chỉ
 * làm hai environment xa lạ xếp hàng sau nhau, không làm sai kết quả nào.
 */
export const lockEnvironment = async (
  tx: Prisma.TransactionClient,
  environmentId: string,
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${environmentId}, 0))`;
};

/**
 * Project của một environment — `undefined` nghĩa là environment không tồn tại.
 *
 * Hai việc trong một câu: phép kiểm 404 của biên trong (Service 1 đã kiểm, nhưng
 * route nội bộ không tin id trần — R05), và `project_id` mà hàng `audit_logs` bắt
 * buộc phải có. Service 2 không có quyền nào trên `projects`, nhưng nó đọc được
 * `environments` (I22), và cột `project_id` ở đó là đường duy nhất tới project.
 */
export async function projectIdOf(
  tx: Prisma.TransactionClient,
  environmentId: string,
): Promise<string | undefined> {
  const row = await tx.environment.findUnique({
    where: { id: environmentId },
    select: { projectId: true },
  });
  return row?.projectId;
}

/** Hàng đã có cùng `key_hash` — đủ trường để V4 quyết 200 hay 409 */
export interface SdkKeyByHash {
  id: string;
  environmentId: string;
  keyType: SdkKeyType;
  createdById: string;
}

/**
 * Tra theo `key_hash` TRƯỚC khi đếm quota (V4, C-05).
 *
 * Thứ tự đó là điều kiện đúng đắn, không phải tối ưu: lần thử lại của Service 1
 * sau một timeout gửi lại CÙNG vật liệu, và nếu quota được đếm trước thì một
 * environment vừa đủ 20 khoá trả 422 cho chính khoá nó vừa tạo — người dùng mất
 * plaintext của một khoá đang hợp lệ.
 *
 * Không thể thay bằng "INSERT rồi bắt lỗi unique": một lỗi ràng buộc làm cả
 * transaction Postgres huỷ (`25P02`), nên sau INSERT hỏng không đọc lại được hàng
 * đã có. Vì vậy P2002 còn sót được bắt NGOÀI transaction và cả hàm chạy lại.
 */
export const byHash = (
  tx: Prisma.TransactionClient,
  keyHash: string,
): Promise<SdkKeyByHash | null> =>
  tx.sdkKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      environmentId: true,
      keyType: true,
      createdById: true,
    },
  });

/** Số khoá CHƯA thu hồi của environment — trần `SDK_KEY.maxActivePerEnvironment` (V5) */
export const countActive = (
  tx: Prisma.TransactionClient,
  environmentId: string,
): Promise<number> =>
  tx.sdkKey.count({ where: { environmentId, revokedAt: null } });

export interface InsertSdkKeyInput {
  environmentId: string;
  keyType: SdkKeyType;
  keyHash: string;
  keySuffix: string;
  label: string | null;
  createdById: string;
}

/** Khoá mới. `id`, `created_at` là mặc định phía database */
export const insert = (
  tx: Prisma.TransactionClient,
  input: InsertSdkKeyInput,
): Promise<{ id: string }> =>
  tx.sdkKey.create({ data: input, select: { id: true } });

export interface SdkKeyTarget {
  id: string;
  keyType: SdkKeyType;
  keySuffix: string;
  label: string | null;
  /** `null` nghĩa là còn sống; mốc đã có thì lần thu hồi sau là no-op */
  revokedAt: Date | null;
}

/**
 * Khoá cần thu hồi, tra bằng CẢ `id` và `environment_id` trong một câu (R05).
 *
 * Hai điều kiện trong cùng một `WHERE` chứ không "đọc rồi so ở JS": phép so ở JS
 * là một bước rời mà người sửa sau có thể bỏ, còn điều kiện trong câu truy vấn
 * thì không bỏ được mà vẫn chạy. Khoá của environment khác ra `null` ⇒ 404, giống
 * hệt khoá không tồn tại — không phân biệt hai ca, vì phân biệt là nói cho người
 * dò biết id nào có thật.
 */
export const targetOf = (
  tx: Prisma.TransactionClient,
  keyId: string,
  environmentId: string,
): Promise<SdkKeyTarget | null> =>
  tx.sdkKey.findFirst({
    where: { id: keyId, environmentId },
    select: {
      id: true,
      keyType: true,
      keySuffix: true,
      label: true,
      revokedAt: true,
    },
  });

/**
 * Đặt `revoked_at` — `undefined` nếu không hàng nào thoả (đã thu hồi trước đó).
 *
 * `now()` của database chứ không `new Date()` của tiến trình: mốc này là thời
 * điểm khoá mất hiệu lực, và guard của mọi replica đọc nó bằng đồng hồ của
 * database. Một mốc lấy từ đồng hồ tiến trình lệch vài giây sẽ nói sai về đúng
 * thứ mà một sự cố an ninh cần biết chính xác.
 *
 * `revoked_at IS NULL` trong `WHERE` là phép kiểm đua cuối cùng: hai lời thu hồi
 * cùng lúc đều vào được `mutate` (chúng xếp hàng sau khoá hàng environment), và
 * bên thứ hai phải ra 0 hàng để bên gọi lùi transaction thay vì ghi dòng outbox
 * và hàng audit thứ hai (AC-4.6).
 */
export async function revoke(
  tx: Prisma.TransactionClient,
  keyId: string,
  environmentId: string,
): Promise<Date | undefined> {
  const rows = await tx.$queryRaw<{ revokedAt: Date }[]>`
    UPDATE sdk_keys
       SET revoked_at = now()
     WHERE id = ${keyId}::uuid
       AND environment_id = ${environmentId}::uuid
       AND revoked_at IS NULL
    RETURNING revoked_at AS "revokedAt"`;
  return rows[0]?.revokedAt;
}
