import { env } from "@udp/config";
import {
  assertConnectedAs,
  createPrismaClient,
  type Prisma,
  type PrismaClient,
} from "@udp/db";

/**
 * Kết nối database của Service 3.
 *
 * Nối bằng role `udp_s3` — role hẹp nhất của ba service (§1.2, I22): UPDATE
 * đúng tám cột của `rollout_sessions`, INSERT `rollout_events` (chỉ event thực
 * thi), một cột `processed_at` để đánh dấu intent, và ngoại lệ kill-switch trên
 * `flag_targeting_rules.serve`. Mọi lệnh ghi khác bị database từ chối, nên một
 * bug của reconciler không thể sửa cấu hình flag của người dùng ngoài đường đã
 * khai.
 *
 * Một hệ quả thực tế của ma trận cột, đo ngày 12/09/2026: Prisma `update()` trên
 * `rollout_sessions` LUÔN bị 42501 vì `@updatedAt` tự thêm `SET updated_at`, mà
 * cột đó thuộc Service 1. Mọi lệnh ghi session của S3 vì thế là SQL thô với danh
 * sách SET tường minh — xem `rollout-session/session.repository.ts`.
 */
export const prisma: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL_S3,
  max: env.DATABASE_POOL_MAX,
  cacheKey: "__udp_prisma_s3",
});

export const SERVICE_ROLE = "udp_s3";

/** Client hoặc transaction — mọi repository nhận cả hai để gọi được trong `$transaction` */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/** Gọi lúc khởi động — xem `assertConnectedAs` để biết vì sao nó phải ném */
export const assertServiceIdentity = (): Promise<void> =>
  assertConnectedAs(prisma, SERVICE_ROLE);
