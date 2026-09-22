import type { PrismaClient } from "@udp/db";
import { configHashOf } from "@udp/flag-evaluator";
import { snapshotOf } from "@udp/flag-snapshot";

/**
 * Đặt lại mốc `config_hash` theo định dạng snapshot HIỆN TẠI — chạy một lần sau
 * migration đổi định dạng (v4.6: `snapshot_format_v46`), với Service 2 và 3 đã
 * dừng.
 *
 * Vì sao không để mốc rỗng chờ lần ghi kế: environment lâu không ai sửa (thường
 * là production) sẽ mất lớp đối chiếu nội dung I15a vô thời hạn.
 *
 * KHÔNG tăng `config_version`: nội dung cấu hình không đổi, chỉ cách băm đổi.
 * Khoá hàng `environments` như bước 1 của ADR-05, để một writer lỡ còn sống
 * không xen giữa lúc đọc snapshot và lúc ghi hash.
 */
export async function rehashEnvironment(
  client: PrismaClient,
  environmentId: string,
): Promise<string> {
  return client.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM environments WHERE id = ${environmentId}::uuid FOR UPDATE`;
      const configHash = configHashOf(await snapshotOf(tx, environmentId));
      await tx.environment.update({
        where: { id: environmentId },
        data: { configHash },
      });
      return configHash;
    },
    { timeout: 20_000, maxWait: 5_000 },
  );
}

/** Mọi environment, từng cái một — một lỗi không bỏ dở những cái còn lại */
export async function rehashAll(
  client: PrismaClient,
): Promise<{ rehashed: number; failed: { id: string; error: string }[] }> {
  const environments = await client.environment.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const failed: { id: string; error: string }[] = [];
  for (const { id } of environments) {
    try {
      await rehashEnvironment(client, id);
    } catch (err: unknown) {
      failed.push({
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { rehashed: environments.length - failed.length, failed };
}
