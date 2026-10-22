import { maskedKeyOf } from "@udp/db";
import type { SdkKeyRow } from "./environment.repository.js";
import type { SdkKeyListView, SdkKeyView } from "./sdk-key.types.js";

/**
 * Hàng `sdk_keys` → hình dạng §3.1 [v4.9].
 *
 * Tách khỏi service cùng lý do `segment.view.ts`: ba đường (danh sách, response
 * tạo, response thu hồi) trả CÙNG một hình cho cùng một khoá, và cách duy nhất
 * bảo đảm điều đó là chúng đi qua đúng một hàm.
 *
 * Đây cũng là biên hẹp nhất để khẳng định điều R04 đòi: hàm này nhận `SdkKeyRow`,
 * và `SdkKeyRow` không có `keyHash` — nên không có đường nào để hash hay plaintext
 * đi lên dây, kể cả khi ai đó nới `select` của repository.
 */

/**
 * `status` suy từ `revoked_at`, không phải một cột riêng.
 *
 * Một cột `status` song song với `revoked_at` là hai nguồn sự thật cho cùng một
 * câu hỏi, và chúng sẽ lệch — guard của Service 2 đọc `revoked_at`, nên nó phải
 * là nguồn duy nhất.
 */
export const keyView = (row: SdkKeyRow): SdkKeyView => ({
  id: row.id,
  environmentId: row.environmentId,
  keyType: row.keyType,
  label: row.label,
  keySuffix: row.keySuffix,
  maskedKey: maskedKeyOf(row.keyType, row.keySuffix),
  status: row.revokedAt === null ? "active" : "revoked",
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

export const keyListView = (rows: readonly SdkKeyRow[]): SdkKeyListView => ({
  keys: rows.map(keyView),
});
