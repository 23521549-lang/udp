import { logger } from "@udp/http";
import { rehashAll } from "../changefeed/rehash.js";
import { assertServiceIdentity, prisma } from "../core/db.js";

/**
 * `pnpm --filter @udp/flag-service rehash` — bước sau migration đổi định dạng
 * snapshot (xem `changefeed/rehash.ts`). Chạy dưới `udp_s2`: role duy nhất được
 * ghi `config_hash` ngoài kill-switch của Service 3.
 */
async function main(): Promise<void> {
  await assertServiceIdentity();
  const { rehashed, failed } = await rehashAll(prisma);
  logger.info(
    { rehashed, failed: failed.length },
    "Đã đặt lại mốc config_hash",
  );
  for (const f of failed) {
    logger.error(f, "Không đặt lại được mốc config_hash cho environment");
  }
  await prisma.$disconnect();
  if (failed.length > 0) process.exitCode = 1;
}

await main();
