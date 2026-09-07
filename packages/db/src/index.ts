import { env, isDevelopment, isProduction } from "@udp/config";
import { createPgAdapter } from "./adapter.js";
import { PrismaClient } from "./generated/prisma/client.js";

/**
 * PrismaClient dùng chung cho cả ba service.
 *
 * Từ Prisma 7, connection không còn khai trong schema mà truyền vào qua **driver
 * adapter**. Đây không phải thay đổi hình thức: `@prisma/adapter-pg` dùng chính
 * pool của `pg`, nên `boss.send()` của pg-boss chạy được TRONG CÙNG TRANSACTION
 * với các lệnh ghi của Prisma. Không có điều đó thì việc "đưa job vào hàng đợi và
 * ghi bản ghi nghiệp vụ trong một transaction" của ADR-02 không thành lập, và ta
 * phải chuyển sang mô hình outbox có relay — thêm một thành phần và một lớp trễ.
 *
 * Chuỗi kết nối dùng ở đây là `DATABASE_URL` (pooled). Migrate, seed và pg-boss
 * dùng `DATABASE_URL_DIRECT` (session mode) vì chúng cần trạng thái session tồn
 * tại qua nhiều statement — xem prisma.config.ts và §15.3.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Vì sao giữ instance trên globalThis: trong dev, hot-reload nạp lại module nhiều
 * lần; mỗi lần `new PrismaClient()` mở một pool riêng và sẽ cạn max_connections
 * sau vài chục lần sửa file. Với free tier của Postgres managed, hạn mức kết nối
 * còn thấp hơn nhiều so với Postgres tự dựng, nên điều này càng quan trọng.
 */
function createPrismaClient(): PrismaClient {
  const adapter = createPgAdapter({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
  });

  return new PrismaClient({
    adapter,
    log: isDevelopment ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/**
 * BigInt không serialize được bằng JSON.stringify — Node ném
 * "TypeError: Do not know how to serialize a BigInt".
 *
 * Schema có hai cột BigInt: `ConfigChangeLog.id` và `FlagEvaluationStat.evalCount`.
 * Không có patch này thì bất kỳ endpoint nào trả về chúng sẽ sập LÚC CHẠY chứ
 * không phải lúc biên dịch, nên TypeScript không bắt được.
 *
 * Dạy JSON cách serialize BigInt thành string một lần ở đây, thay vì rải
 * `.toString()` ở mọi controller và chắc chắn sẽ quên một chỗ.
 */
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

if (typeof BigInt.prototype.toJSON !== "function") {
  BigInt.prototype.toJSON = function toJSON(this: bigint): string {
    return this.toString();
  };
}

export { createPgAdapter } from "./adapter.js";
export * from "./generated/prisma/client.js";
export * from "./generated/prisma/enums.js";
