import { env } from "@udp/config";
import {
  assertConnectedAs,
  createPrismaClient,
  type PrismaClient,
} from "@udp/db";

/**
 * Kết nối database của Service 1.
 *
 * Service này nối bằng role `udp_s1`, KHÔNG phải user owner. Đó là điều kiện để
 * ma trận writer §1.2 có hiệu lực thật: từ đây, một module của core-backend vô ý
 * ghi vào bảng của Service 2 sẽ nhận `42501 permission denied` từ database ngay
 * lúc phát triển, thay vì trở thành một dòng quy ước mà người viết tiếp không
 * biết. GRANT theo cột và trigger `is_intent` chuyển từ "đã kiểm bằng SET ROLE
 * trong test" thành "đang chặn trên đường ghi thật".
 *
 * Client dựng ở đây chứ không ở `@udp/db` là có chủ đích: package đó dùng chung
 * cho cả ba service, nên một singleton trong đó sẽ ép cả ba mang một danh tính.
 * Danh tính kết nối là chuyện của service, không phải của thư viện.
 */
export const prisma: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL_S1,
  max: env.DATABASE_POOL_MAX,
  cacheKey: "__udp_prisma_s1",
});

/** Gọi lúc khởi động — xem `assertConnectedAs` để biết vì sao nó phải ném */
export const assertServiceIdentity = (): Promise<void> =>
  assertConnectedAs(prisma, "udp_s1");
