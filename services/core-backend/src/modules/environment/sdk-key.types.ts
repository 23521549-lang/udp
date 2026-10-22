import { z } from "zod";
import { SDK_KEY } from "@udp/config";
import { SdkKeyType } from "@udp/db";

/**
 * Hợp đồng HTTP của SDK key ở biên NGOÀI (§3.1, L7) [v4.9].
 *
 * Người dùng gửi ĐÚNG hai thứ: loại khoá và một nhãn tuỳ chọn. Họ không gửi
 * `keyHash`, `keySuffix` hay `environmentId` — cái đầu do Service 1 tính từ token
 * nó vừa sinh, cái cuối nằm trên đường dẫn. Nhận bất kỳ thứ nào trong số đó từ
 * thân là mở một đường cho người gọi chọn environment khác environment họ vừa
 * được kiểm quyền trên, hoặc gắn một hash họ tự chọn lên một khoá (I14, R05).
 */

/**
 * `label` nhận `null` TƯỜNG MINH bên cạnh "thiếu hẳn".
 *
 * Portal cần một cách xoá nhãn khỏi form mà không phải bỏ trường, và `.strict()`
 * thì một trường lạ là 400 — nên hai dạng phải được khai ra, không đoán. Chuỗi
 * rỗng thì KHÔNG hợp lệ: một nhãn rỗng và một khoá không nhãn là cùng một thứ,
 * và cho phép cả hai là hai cách biểu diễn cho một trạng thái.
 */
export const createSdkKeyBodySchema = z
  .object({
    /** Enum lấy THẲNG từ `@udp/db`, không chép tay — khuôn của `flag.types.ts` */
    keyType: z.nativeEnum(SdkKeyType),
    label: z
      .string()
      .trim()
      .min(1)
      .max(SDK_KEY.labelMaxLength)
      .nullable()
      .optional(),
  })
  .strict();

/** `all` là mặc định: Portal mở trang khoá và muốn thấy cả khoá đã thu hồi */
export const listSdkKeysQuerySchema = z
  .object({
    status: z.enum(["active", "revoked", "all"]).default("all"),
  })
  .strict();

export type CreateSdkKeyBody = z.infer<typeof createSdkKeyBodySchema>;
export type ListSdkKeysQuery = z.infer<typeof listSdkKeysQuerySchema>;

/**
 * Hình một khoá trên dây (§3.1).
 *
 * Không có `keyHash`, và sẽ không bao giờ có: nó là thứ duy nhất database dùng để
 * tra khoá, nên đưa nó ra khỏi cột đó là hạ mức bảo vệ của chính cột đó. Không có
 * plaintext: nó chỉ tồn tại trong response TẠO, ở một trường riêng cạnh `key`
 * (V3) và đúng một lần.
 *
 * `maskedKey` dựng từ `keyType` + `keySuffix` ĐÃ LƯU, không dựng lại `envSlug` từ
 * tên environment hiện tại: environment đổi tên được, còn khoá đã phát hành thì
 * không đổi — nên phần duy nhất đáng tin là đuôi trong database (design:974).
 */
export interface SdkKeyView {
  id: string;
  environmentId: string;
  keyType: SdkKeyType;
  label: string | null;
  keySuffix: string;
  /** `udp_sk_…a1b2c3` — tiền tố theo LOẠI, đuôi theo hàng đã lưu */
  maskedKey: string;
  status: "active" | "revoked";
  createdBy: { id: string; name: string };
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface SdkKeyListView {
  keys: SdkKeyView[];
}

/**
 * Response của POST (§3.1, V3, AC-4.1).
 *
 * `secretKey` nằm CẠNH `key`, không nằm trong nó — hai lý do, cả hai đã được cân:
 * `redact()` che mọi khoá khớp `/secret/i` và `redactPaths` của pino có
 * `*.secretKey`, nên cả hai lớp che đúng trường này nếu nó vô tình lọt vào audit
 * hay vào một dòng log; và để ngoài `key` thì nó không đi vào danh sách khoá mà
 * Portal cache (R04, A-L6).
 */
export interface CreatedSdkKeyView {
  key: SdkKeyView;
  secretKey: string;
}
