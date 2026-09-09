import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { DB_TLS_OPTIONS, sanitizeConnectionString } from "@udp/db";
import { Client } from "pg";

/**
 * Đọc hình dạng thật của database để đối chiếu với tài liệu.
 *
 * Đối chiếu với DATABASE chứ không với `schema.prisma` là quyết định có chủ đích.
 * Hai lý do:
 *
 *  1. Không phải viết một parser cho ngôn ngữ schema của Prisma. Parser đó sẽ
 *     giòn, và một linter giòn thì người ta tắt đi.
 *  2. Database là thứ code THẬT SỰ chạy trên đó. Nó cũng đã được bảo đảm khớp
 *     `schema.prisma` bởi phép thử drift (`prisma migrate dev --create-only`
 *     phải sinh migration rỗng), nên không mất mắt xích nào.
 *
 * Ngoại lệ duy nhất phải đọc từ `schema.prisma`: ánh xạ tên model → tên bảng.
 * Nó không suy ra được bằng quy ước — `FeatureFlag` thành `feature_flags` (số
 * nhiều) nhưng `ConfigChangeLog` thành `config_change_log` (số ít). Đọc bằng
 * hai regex trên `@@map` chứ không phân tích cả file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, "../../db/prisma/schema.prisma");
loadDotenv({ path: resolve(here, "../../../.env") });

/** `FeatureFlag` → `feature_flags`, đọc từ `@@map` trong schema.prisma */
export function modelToTableMap(): Map<string, string> {
  const text = readFileSync(SCHEMA_PATH, "utf8");
  const map = new Map<string, string>();

  for (const block of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const model = block[1];
    const body = block[2];
    if (model === undefined || body === undefined) continue;
    const mapped = /@@map\("([^"]+)"\)/.exec(body)?.[1];
    if (mapped === undefined) {
      throw new Error(
        `model ${model} không có @@map — quy ước của repo là mọi model đều khai`,
      );
    }
    map.set(model, mapped);
  }

  if (map.size === 0)
    throw new Error("Không đọc được model nào từ schema.prisma");
  return map;
}

export interface DbColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
}

export async function openClient(): Promise<Client> {
  const url = process.env["DATABASE_URL_DIRECT"];
  if (!url) throw new Error("DATABASE_URL_DIRECT chưa được đặt");
  const client = new Client({
    connectionString: sanitizeConnectionString(url),
    ssl: DB_TLS_OPTIONS,
  });
  await client.connect();
  return client;
}

/** Toàn bộ cột của schema `public`, nhóm theo tên bảng */
export async function readDbColumns(
  client: Client,
): Promise<Map<string, DbColumn[]>> {
  const res = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
      ORDER BY table_name, ordinal_position`,
  );

  const byTable = new Map<string, DbColumn[]>();
  for (const r of res.rows) {
    const list = byTable.get(r.table_name) ?? [];
    list.push({
      name: r.column_name,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
      hasDefault: r.column_default !== null,
    });
    byTable.set(r.table_name, list);
  }
  return byTable;
}
