import { z } from "zod";
import { SDK_KEY } from "@udp/config";
import {
  SDK_KEY_HASH_PATTERN,
  SDK_KEY_SUFFIX_PATTERN,
  SdkKeyType,
} from "@udp/db";

/**
 * Hợp đồng của hai route `/internal/sdk-keys` (§3.2, §9, L7) [v4.9].
 *
 * Thứ KHÔNG có ở đây là điều đáng nói nhất: không có trường nào mang token thô.
 * Service 1 sinh token, băm nó, rồi gửi xuống ĐÚNG hai thứ dẫn xuất — `keyHash`
 * để tra và `keySuffix` để hiển thị (L7, R04). Nhờ vậy plaintext không bao giờ đi
 * qua mạng nội bộ, không vào log của Service 2, không vào `details` của một lỗi
 * validate, và không có gì để lộ nếu bí mật nội bộ bị đọc.
 *
 * Không đặt hình này ở `@udp/shared-types` như segment: hai biên nhận hai thứ
 * KHÁC nhau (biên ngoài nhận `{keyType, label}` và tự sinh vật liệu, biên trong
 * nhận vật liệu đã sinh), nên không có hình chung nào để chia sẻ. Thứ duy nhất
 * dùng chung là công thức sinh vật liệu, và nó ở `@udp/db` (R8).
 */

/**
 * `label` là `.nullable()` chứ không `.optional()`.
 *
 * Service 1 luôn gửi trường này — `body.label ?? null` — nên biên trong không
 * phải đoán "thiếu nghĩa là gì". `.strict()` thì một trường lạ là 400, và đó là
 * cách một lệch hợp đồng giữa hai service lộ ra ngay ở test thay vì âm thầm bị
 * bỏ (R36).
 */
export const createSdkKeySchema = z
  .object({
    environmentId: z.string().uuid(),
    /** Enum lấy THẲNG từ `@udp/db`, không chép tay — khuôn của `rollout.types.ts` */
    keyType: z.nativeEnum(SdkKeyType),
    label: z.string().trim().min(1).max(SDK_KEY.labelMaxLength).nullable(),
    /** `sha256(token)` hex — xem `SDK_KEY_HASH_PATTERN` của `@udp/db` */
    keyHash: z.string().regex(SDK_KEY_HASH_PATTERN),
    keySuffix: z.string().regex(SDK_KEY_SUFFIX_PATTERN),
  })
  .strict();

/**
 * `environmentId` của DELETE đi bằng QUERY — lớp phòng thủ thứ hai của R05.
 *
 * Cùng lý lẽ với `projectId` của route segment: Service 1 đã kiểm khoá thuộc
 * environment và environment thuộc project trước khi gọi, nhưng route nội bộ
 * không được tin một id trần. Nó đi vào chính mệnh đề `WHERE` của lệnh UPDATE, và
 * lệch thì 0 hàng ⇒ 404. Thiếu nó thì một lỗi ở Service 1 (hay một bên gọi nội bộ
 * tương lai) đủ để thu hồi khoá của tenant khác chỉ bằng một id.
 */
export const revokeSdkKeyQuerySchema = z
  .object({ environmentId: z.string().uuid() })
  .strict();

export type CreateSdkKeyInput = z.infer<typeof createSdkKeySchema>;
export type RevokeSdkKeyQuery = z.infer<typeof revokeSdkKeyQuerySchema>;

/**
 * Kết quả tạo khoá (§3.2, V4).
 *
 * `created` phân biệt "vừa INSERT" với "đã có hàng cùng `key_hash`" — lần thử lại
 * của Service 1 sau một timeout rơi vào ca thứ hai, và nó phải là 200 chứ không
 * 201 để bên gọi biết không có gì mới được ghi (không audit, không quota tiêu
 * thêm). Service 1 vẫn trả 201 cho người dùng vì với họ khoá đúng là vừa được
 * phát hành — plaintext nằm trong bộ nhớ của nó suốt cả hai lần thử (AC-5.5).
 */
export interface SdkKeyStamp {
  id: string;
  created: boolean;
}

/**
 * Kết quả thu hồi (§3.2, AC-4.6).
 *
 * `revokedAt` là mốc ĐANG CÓ, không phải mốc của lần gọi này: thu hồi lần thứ hai
 * trả 200 với đúng mốc lần đầu, vì "đã thu hồi" là trạng thái cuối và một mốc mới
 * sẽ nói dối về lúc khoá thật sự mất hiệu lực. `changed` cho bên gọi biết lần này
 * có ghi gì không — và đó là thứ test đếm để khẳng định 1 audit, 1 dòng outbox.
 */
export interface SdkKeyRevocation {
  id: string;
  revokedAt: Date;
  changed: boolean;
}
