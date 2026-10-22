/**
 * Đồng bộ `domain_catalog` từ `DOMAIN_CATALOG_SEED` — CHẠY BẰNG DANH TÍNH OWNER.
 *
 * Job `udp-migrate` gọi script này LUÔN (không phụ thuộc `UDP_SEED`), vì catalog là dữ
 * liệu NỀN TẢNG (16 domain của §5.5), không phải dữ liệu demo. Ma trận writer §1.2 chỉ cho
 * ba service `SELECT ON domain_catalog`, nên bước này phải đi đường owner (migrate job),
 * không phải đường service lúc boot.
 *
 * Idempotent: `syncDomainCatalog` chỉ UPSERT, không bao giờ DELETE.
 */

import { DOMAIN_CATALOG_SEED, env } from "@udp/config";
import { createPgAdapter } from "../src/adapter.js";
import { syncDomainCatalog } from "../src/domain-catalog.js";
import { PrismaClient } from "../src/generated/prisma/client.js";

const connectionString =
  process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Thiếu DATABASE_URL_DIRECT (hoặc DATABASE_URL) trong .env");
}

const prisma = new PrismaClient({
  adapter: createPgAdapter({
    connectionString,
    max: 2,
    tlsMode: env.UDP_DB_TLS_MODE,
  }),
});

try {
  const outcome = await syncDomainCatalog(prisma, DOMAIN_CATALOG_SEED);
  console.info(
    `domain_catalog: đã đồng bộ ${outcome.upserted} domain` +
      (outcome.reEnabled.length > 0
        ? ` (bật lại: ${outcome.reEnabled.join(", ")})`
        : "") +
      (outcome.markedUnavailable.length > 0
        ? ` (đánh dấu ngừng: ${outcome.markedUnavailable.join(", ")})`
        : ""),
  );
} finally {
  await prisma.$disconnect();
}
