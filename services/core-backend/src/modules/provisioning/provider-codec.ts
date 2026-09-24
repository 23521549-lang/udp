import { CLOUD_PROVIDERS, type CloudProvider } from "@udp/adapter-core";
import { CloudProvider as DbCloudProvider } from "@udp/db";

/**
 * [v4.10] Dịch `CloudProvider` giữa cổng adapter và enum của database.
 *
 * Hai bên KHÔNG cùng chữ, và không nên cùng chữ:
 *
 * - Cổng adapter dùng chữ thường (`"aws"`) vì đó là dạng đi vào **tag trên tài nguyên
 *   cloud** và vào `idempotencyKey` — hai chuỗi mà người vận hành đọc bằng mắt trong
 *   console của nhà cung cấp, và là đường tra cứu thứ nhất của ADR-08. Đổi chúng sang
 *   chữ hoa để "cho giống database" là để một lũ tag đã gắn trên tài nguyên thật không
 *   còn khớp.
 * - Database dùng chữ hoa vì đó là quy ước của mọi enum trong `schema.prisma`.
 *
 * Nên chỗ đúng để trả giá là MỘT hàm dịch có kiểm, không phải một `as` ở mỗi lần đọc
 * ghi. `as` thì đúng cho tới ngày ai đó thêm nhà cung cấp thứ tư ở một bên; hàm này thì
 * ngày đó không biên dịch được, và phép kiểm gương trong `design-lint` đỏ.
 */

const TO_DB: Readonly<Record<CloudProvider, DbCloudProvider>> = {
  aws: DbCloudProvider.AWS,
  gcp: DbCloudProvider.GCP,
  azure: DbCloudProvider.AZURE,
};

/**
 * Chiều ngược, dựng TỪ `TO_DB` chứ không viết tay lần thứ hai.
 *
 * Viết tay hai bảng là mở ra trạng thái "một chiều đúng, chiều kia sai" — và chiều sai
 * đó chỉ lộ ra khi đọc lại một hàng đã ghi, tức muộn hơn hẳn chỗ gây lỗi.
 */
const FROM_DB = new Map<DbCloudProvider, CloudProvider>(
  CLOUD_PROVIDERS.map((p) => [TO_DB[p], p]),
);

export function providerToDb(provider: CloudProvider): DbCloudProvider {
  return TO_DB[provider];
}

export function providerFromDb(provider: DbCloudProvider): CloudProvider {
  const mapped = FROM_DB.get(provider);
  if (mapped === undefined) {
    /**
     * Không thể xảy ra khi hai danh sách còn khớp — và chính vì thế nó phải ném thay vì
     * đoán. Một giá trị enum mới trong database mà bảng này chưa biết nghĩa là sổ đang
     * đọc một hàng nó không hiểu; trả về một giá trị mặc định ở đây là ghi tag sai lên
     * tài nguyên thật ở bước sau.
     */
    throw new Error(`enum CloudProvider của database có giá trị lạ: ${provider}`);
  }
  return mapped;
}
