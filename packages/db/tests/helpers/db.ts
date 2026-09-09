import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { Client } from "pg";
import { DB_TLS_OPTIONS, sanitizeConnectionString } from "../../src/adapter.js";

// Cùng khuôn với packages/config/src/env.ts: đi lên từ file này tới gốc workspace.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

/**
 * Kết nối bằng DATABASE_URL_DIRECT (session mode).
 *
 * Test dùng `SET ROLE` và `SET CONSTRAINTS` — cả hai là trạng thái mức SESSION.
 * Pooler ở transaction mode trả kết nối về pool sau mỗi statement nên trạng thái
 * đó biến mất giữa chừng, cùng lý do migrate phải dùng chuỗi này (§15.3).
 *
 * Dùng lại `sanitizeConnectionString` và `DB_TLS_OPTIONS` của `src/adapter.ts` chứ không tự
 * viết: adapter tự nhận là nơi DUY NHẤT biết cách mở kết nối, và một bản sao
 * trong test sẽ trôi khỏi nó — đúng như đã trôi thật, bản trước hạ
 * `rejectUnauthorized` và cắt `sslmode` bằng regex làm mất dấu `?` khi nó là
 * tham số đầu tiên.
 */
export function connectionString(): string {
  const url = process.env["DATABASE_URL_DIRECT"];
  if (!url) throw new Error("DATABASE_URL_DIRECT chưa được đặt");
  return url;
}

export async function openClient(): Promise<Client> {
  const client = new Client({
    connectionString: sanitizeConnectionString(connectionString()),
    ssl: DB_TLS_OPTIONS,
  });
  await client.connect();
  return client;
}

/** Chạy `body` trong một transaction rồi LUÔN rollback — test không để lại dấu vết */
export async function inRollback<T>(
  client: Client,
  body: () => Promise<T>,
): Promise<{ value?: T; error?: { code?: string; message: string } }> {
  await client.query("BEGIN");
  try {
    const value = await body();
    return { value };
  } catch (err) {
    const e = err as { code?: string; message: string };
    return {
      error: {
        ...(e.code === undefined ? {} : { code: e.code }),
        message: e.message,
      },
    };
  } finally {
    await client.query("ROLLBACK");
  }
}
