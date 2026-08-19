import { env, isDevelopment, isProduction } from "@udp/config";
import { PrismaClient } from "@prisma/client";

/**
 * PrismaClient singleton dùng chung cho cả 3 service.
 *
 * Giữ instance trên globalThis vì trong dev, hot-reload nạp lại module nhiều
 * lần; mỗi lần `new PrismaClient()` mở một pool riêng và sẽ cạn max_connections
 * của PostgreSQL sau vài chục lần sửa file.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isDevelopment ? ["query", "warn", "error"] : ["warn", "error"],
    datasources: { db: { url: env.DATABASE_URL } },
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/**
 * BigInt không serialize được bằng JSON.stringify — Node ném
 * "TypeError: Do not know how to serialize a BigInt".
 *
 * Schema có hai cột BigInt: `ConfigChangeLog.id` và
 * `FlagEvaluationStat.evalCount`. Không có patch này thì bất kỳ endpoint nào
 * trả về chúng — ví dụ `GET /flags/:id/stats` — sẽ sập lúc chạy chứ không
 * phải lúc biên dịch, nên TypeScript không bắt được.
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

export * from "@prisma/client";
