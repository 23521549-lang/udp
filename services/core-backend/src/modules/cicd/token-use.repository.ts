import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@udp/db";

/**
 * [Plan #61 QĐ-17, 61d-2a] Ghi "token này đã tiêu", và phân biệt RETRY với REPLAY (I41).
 *
 * `INSERT ... ON CONFLICT DO NOTHING` rồi nhìn số hàng, **không** bắt lỗi trùng khoá. Hai lý do, cả hai
 * đều có trong repo:
 *
 *  - `23505` **ABORT cả transaction**, nên sau nó không đọc được hàng cũ để biết đây là retry hay replay,
 *    và mọi thứ ghi cùng transaction mất theo — kể cả hàng `deployment_events`.
 *  - `packages/db/src/errors.ts` ghi rằng lỗi phát sinh **lúc COMMIT** tới dưới dạng `DriverAdapterError`
 *    với `code === undefined`, nên `uniqueViolationIndexOf` không nhận ra nó. Và
 *    `provisioning/prisma-ledger.ts` đã chốt cách đúng thành chữ: dùng `skipDuplicates` "cùng một câu SQL,
 *    cùng một bảo đảm, nhưng KHÔNG sinh một dòng `prisma:error` cho một đường đi bình thường".
 *
 * Gọi nó ở ĐÂU cũng là một phần của đặc tả: sau nhánh chống trùng theo `pipelineId` và sau quyết định
 * rebase, tức tại điểm mà MỌI đường còn lại đều ghi đúng một `deployment_events`. Luật một câu: **token bị
 * tiêu đúng khi một `deployment_events` được commit**. Nhánh `duplicate` và hai nhánh `unchanged`/`skipped`
 * của rebase không tiêu gì, nên một lượt chạy bị bỏ qua không đốt mất token của nó.
 */

export type TokenUseOutcome =
  /** Lần dùng đầu — đi tiếp */
  | { kind: "first" }
  /**
   * Token đã dùng rồi NHƯNG thân giống hệt từng byte: một lượt retry thật của CI (phản hồi mất trên đường
   * về sau khi server đã commit). Trả lại kết quả cũ, đừng để bước báo đỏ trong khi deploy đã chạy thật.
   */
  | { kind: "retry"; deploymentId: string | null }
  /** Token đã dùng rồi và thân KHÁC: một lượt replay */
  | { kind: "replayed" };

/**
 * Dấu của thân, để so hai lần trình có phải cùng một báo cáo.
 *
 * SHA-256 trần, không phải HMAC, và đó là một quyết định có chủ đích: hàng này chỉ được ghi SAU khi chữ ký
 * HMAC đã đúng, nên tính "có khoá" không thêm bảo đảm nào — việc duy nhất cần là trả lời "có đúng từng
 * byte như lần đầu không". Đổi lại, nó không đòi `verifySignature` trả thêm gì, mà hợp đồng đó đang được
 * `packages/design-lint/tests/cicd-signature.test.ts` canh bằng AST: đúng MỘT lời gọi tới bộ kiểm header
 * và KHÔNG một phép so bằng nào. Nới nó ra chỉ để lấy một digest là trả giá ở sai chỗ.
 */
export const bodyDigestOf = (rawBody: Buffer): string =>
  createHash("sha256").update(rawBody).digest("hex");

export async function recordTokenUse(
  tx: Prisma.TransactionClient,
  args: {
    projectId: string;
    issuer: string;
    tokenId: string;
    pipelineId: string;
    environmentId: string;
    bodyDigest: string;
    deploymentId: string;
    /** `exp` của chính token — không bao giờ nhỏ hơn nó, kẻo lượt dọn mở lại cửa sổ replay */
    expiresAt: Date;
  },
): Promise<TokenUseOutcome> {
  const { count } = await tx.webhookTokenUse.createMany({
    data: [
      {
        id: randomUUID(),
        projectId: args.projectId,
        issuer: args.issuer,
        tokenId: args.tokenId,
        pipelineId: args.pipelineId,
        environmentId: args.environmentId,
        bodyDigest: args.bodyDigest,
        deploymentId: args.deploymentId,
        expiresAt: args.expiresAt,
      },
    ],
    skipDuplicates: true,
  });
  if (count === 1) return { kind: "first" };

  const held = await tx.webhookTokenUse.findUnique({
    where: { issuer_tokenId: { issuer: args.issuer, tokenId: args.tokenId } },
    select: { bodyDigest: true, deploymentId: true },
  });
  // Hàng biến mất giữa hai câu lệnh (một lượt dọn chen vào) là chuyện có thể xảy ra về lý thuyết; coi là
  // replay chứ không coi là lần đầu, vì fail-closed ở đây chỉ làm một lượt chạy phải xin token mới.
  if (held === null) return { kind: "replayed" };
  return held.bodyDigest === args.bodyDigest
    ? { kind: "retry", deploymentId: held.deploymentId }
    : { kind: "replayed" };
}
