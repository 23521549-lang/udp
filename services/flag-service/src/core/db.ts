import { env } from "@udp/config";
import {
  assertConnectedAs,
  createPrismaClient,
  type PrismaClient,
} from "@udp/db";

/**
 * Kết nối database của Service 2.
 *
 * Service này nối bằng role `udp_s2`, KHÔNG phải user owner. Với S2 điều đó còn
 * quan trọng hơn với S1 một bậc: §1.2 chỉ cho phép nó UPDATE **đúng hai cột**
 * của `environments` — `config_version` và `config_hash`. Mọi cột khác của bảng
 * đó thuộc Service 1. Nối bằng owner là xoá luôn ranh giới ấy, và một lỗi lập
 * trình ghi đè `k8s_namespace` hay `name` sẽ thành công trong im lặng.
 *
 * `cacheKey` phải KHÁC của Service 1. Hai service dùng chung một khoá nghĩa là
 * dùng chung một instance trên `globalThis`, và service khởi động sau sẽ lặng lẽ
 * mượn danh tính của service khởi động trước — xem `createPrismaClient`.
 */
export const prisma: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL_S2,
  max: env.DATABASE_POOL_MAX,
  cacheKey: "__udp_prisma_s2",
});

/**
 * Role mà MỌI kết nối của Service 2 phải mang — pool của Prisma lẫn kênh LISTEN
 * của tầng 3. Một hằng cho cả hai chốt: hai chuỗi ký tự rời là hai chỗ để lệch.
 */
export const SERVICE_ROLE = "udp_s2";

/** Gọi lúc khởi động — xem `assertConnectedAs` để biết vì sao nó phải ném */
export const assertServiceIdentity = (): Promise<void> =>
  assertConnectedAs(prisma, SERVICE_ROLE);
