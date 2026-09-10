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
 * Chuỗi kết nối do NGƯỜI GỌI truyền vào, không đọc từ env ở đây.
 *
 * Đó là điều kiện để ma trận writer §1.2 có hiệu lực: mỗi service nối bằng
 * ROLE CỦA RIÊNG NÓ (`udp_s1` / `udp_s2` / `udp_s3`), nên GRANT theo cột trở
 * thành ràng buộc thật chứ không phải một bảng trong tài liệu. Một singleton
 * dùng chung trong package này sẽ ép cả ba service dùng một danh tính, và toàn
 * bộ 187 test canh GRANT chỉ còn đúng bên trong `SET ROLE` của chính chúng.
 *
 * Migrate, seed và pg-boss vẫn dùng `DATABASE_URL_DIRECT` (session mode) với
 * user owner: chúng cần trạng thái session qua nhiều statement, và seed ghi vào
 * lãnh địa của cả ba service — xem prisma.config.ts và §15.3.
 */
export interface PrismaClientOptions {
  connectionString: string;
  max: number;
  /** Khoá giữ instance trên globalThis — mỗi service một khoá riêng */
  cacheKey: string;
}

/**
 * Vì sao giữ instance trên globalThis: trong dev, hot-reload nạp lại module nhiều
 * lần; mỗi lần `new PrismaClient()` mở một pool riêng và sẽ cạn max_connections
 * sau vài chục lần sửa file. Với free tier của Postgres managed, hạn mức kết nối
 * còn thấp hơn nhiều so với Postgres tự dựng, nên điều này càng quan trọng.
 */
export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  const cache = globalThis as unknown as Record<
    string,
    PrismaClient | undefined
  >;
  const cached = cache[options.cacheKey];
  if (cached !== undefined) return cached;

  const client = new PrismaClient({
    adapter: createPgAdapter({
      connectionString: options.connectionString,
      max: options.max,
    }),
    log: isDevelopment ? ["query", "warn", "error"] : ["warn", "error"],
  });

  if (!isProduction) cache[options.cacheKey] = client;
  return client;
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

export {
  createPgAdapter,
  DB_TLS_OPTIONS,
  sanitizeConnectionString,
} from "./adapter.js";
export { assertConnectedAs } from "./identity.js";
export { writeWithOutbox } from "./outbox.js";
export type { ConfigChangeType, OutboxWrite } from "./outbox.js";
export { dbConstraintError, httpStatusOf, UDP_SQLSTATE } from "./errors.js";
export type { DbConstraintError } from "./errors.js";
export * from "./generated/prisma/client.js";
export * from "./generated/prisma/enums.js";
