import { ACTIVE_ROLLOUT_STATUSES } from "@udp/config/constants";
import { Prisma } from "./generated/prisma/client.js";

/**
 * Danh sách status "rollout đang chạy" dạng SQL — dùng trong `status IN (...)`.
 *
 * Vị từ này là HỢP ĐỒNG giữa hai service: Service 2 bỏ qua `untrack` khi config
 * còn session thoả nó, Service 3 chỉ quét gỡ nhãn những config không còn session
 * thoả nó. Hai bản dựng lệch nhau thì lưới quét gọi untrack mãi mà S2 mãi bỏ qua.
 * Tập giá trị vẫn là `ACTIVE_ROLLOUT_STATUSES` của `@udp/config`; đây chỉ là MỘT
 * cách viết nó ra SQL, có ép kiểu enum để Postgres dùng được index trên cột.
 */
export const ACTIVE_ROLLOUT_STATUS_SQL: Prisma.Sql = Prisma.join(
  ACTIVE_ROLLOUT_STATUSES.map(
    (status) => Prisma.sql`${status}::"RolloutStatus"`,
  ),
);
