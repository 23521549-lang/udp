import type { Prisma } from "@udp/db";
import type { PublicEnvConfig } from "./env-config.types.js";

export const PUBLIC_FIELDS = {
  id: true,
  flagId: true,
  environmentId: true,
  isEnabled: true,
  defaultVariantId: true,
  updatedAt: true,
} as const;

/**
 * Environment và key của flag mà một env-config thuộc về.
 *
 * Hai thứ `writeWithOutbox` cần: `environmentId` phải biết TRƯỚC transaction
 * (bước 1 khoá theo nó), còn `flagKey` là thứ `stateFor` dùng để rút delta ra
 * khỏi snapshot. Gọi hai lần — một lần ngoài để biết khoá gì, một lần TRONG
 * `mutate` sau khi đã khoá — vì env-config có thể đã bị xoá (flag bị xoá cuốn
 * theo) trong khe giữa hai lần. Không đọc lại thì `update` gặp hàng đã mất sẽ ném
 * `P2025`, mã không nằm trong bảng ánh xạ, và người gọi nhận 500 thay vì 404.
 */
export async function targetOf(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{ environmentId: string; flagKey: string } | null> {
  const row = await tx.flagEnvConfig.findUnique({
    where: { id },
    select: { environmentId: true, flag: { select: { key: true } } },
  });

  return row === null
    ? null
    : { environmentId: row.environmentId, flagKey: row.flag.key };
}

export const findById = (
  tx: Prisma.TransactionClient,
  id: string,
): Promise<PublicEnvConfig | null> =>
  tx.flagEnvConfig.findUnique({ where: { id }, select: PUBLIC_FIELDS });
