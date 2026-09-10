import { ACTIVE_ROLLOUT_STATUSES } from "@udp/config";
import { writeWithOutbox, type Prisma } from "@udp/db";
import {
  logger,
  NotFoundError,
  PreconditionFailedError,
  UnprocessableError,
} from "@udp/http";
import { canonicalizeServe, flagServeDbSchema } from "@udp/shared-types";
import { prisma } from "../../core/db.js";
import { stateFor } from "../../evaluation/snapshot-builder.js";
import type { FencingToken } from "./fencing.js";
import * as repository from "./rule.repository.js";
import type { PublicRule, RampRuleInput } from "./rule.types.js";

const NOT_FOUND = "Không tìm thấy rule";

/**
 * Ramp trọng số của MỘT rule — đường ghi của Service 3 (§7.3, C1).
 *
 * Rollback đi qua đúng hàm này với `weights` về baseline: Service 2 không biết gì
 * về `baseline_percentage` và không cần biết.
 *
 * Khác `replaceRules` ở ba chỗ, cả ba có chủ ý:
 *
 * - **Quyền ghi đến từ LEASE, không từ mốc optimistic lock.** Bên gọi là một
 *   worker của Service 3, chứng minh quyền bằng fencing token (I23); S2 kiểm token
 *   đó với `RolloutSession` ngay trong transaction ghi (T12).
 * - **`actorUserId` vắng mặt.** §2.2: "NULL = Service 3 khi rollout" — không có
 *   người dùng nào bấm gì. `rolloutSessionId` đi vào payload thay cho nó, nên sổ
 *   vẫn trả lời được "rollout nào đã đổi phần trăm này".
 * - **Chỉ trọng số đổi.** Tập variant, điều kiện, thứ tự ưu tiên, `bucket_salt`
 *   đứng yên. Đổi được tập variant là đổi được CÁI GÌ được phục vụ, trong khi
 *   rollout chỉ có quyền quyết định BAO NHIÊU.
 */
export async function rampRule(
  ruleId: string,
  token: FencingToken,
  input: RampRuleInput,
): Promise<{ rule: PublicRule }> {
  const target = await repository.rampTargetOf(prisma, ruleId);
  if (target === null) throw new NotFoundError(NOT_FOUND);

  let result: { rule: PublicRule } | undefined;

  await writeWithOutbox(prisma, {
    environmentIds: [target.environmentId],
    changeType: "rule.ramped",
    mutate: async (tx) => {
      const fresh = await repository.rampTargetOf(tx, ruleId);
      if (fresh === null) throw new NotFoundError(NOT_FOUND);

      /**
       * Fencing Ở ĐÂY, sau khi bước 1 đã khoá environment — không phải trước
       * transaction. Mọi lần ghi cấu hình của environment này xếp hàng sau khoá
       * đó, nên phép kiểm và phép ghi của một PATCH không bị PATCH khác chen vào
       * giữa. Kiểm trước khi mở transaction là một cửa sổ check-then-act.
       */
      await assertFencing(tx, ruleId, token);

      const current = flagServeDbSchema.parse(fresh.serve);
      if (current.kind !== "distribution") {
        throw new UnprocessableError(
          "Chỉ ramp được rule phục vụ theo PHÂN PHỐI — rule này phục vụ thẳng một variant",
        );
      }
      assertSameVariants(
        current.weights.map((w) => w.variantId),
        input.weights.map((w) => w.variantId),
      );

      await tx.flagTargetingRule.update({
        where: { id: ruleId },
        data: {
          serve: canonicalizeServe({
            kind: "distribution",
            weights: input.weights,
          }),
        },
      });

      /**
       * Đẩy mốc optimistic lock của env-config: người dùng đang mở danh sách rule
       * từ trước lần ramp phải nhận 409 kèm bản mới nhất khi lưu, không phải ghi
       * đè lên phần trăm rollout vừa đặt.
       */
      await tx.flagEnvConfig.update({
        where: { id: fresh.flagEnvConfigId },
        data: { updatedAt: new Date() },
      });

      result = {
        rule: await tx.flagTargetingRule.findUniqueOrThrow({
          where: { id: ruleId },
          select: repository.RULE_FIELDS,
        }),
      };
    },
    stateOf: stateFor(target.flagKey, { rolloutSessionId: token.sessionId }),
  });

  if (result === undefined) {
    throw new Error("writeWithOutbox trả về mà không chạy mutate");
  }

  /**
   * `reason` vào log, không vào database: lý do của một QUYẾT ĐỊNH rollout thuộc
   * về `RolloutEvent` của Service 3 (§7.1), còn "rollout nào" đã nằm trong
   * payload outbox. Lưu nó ở đây là tạo bản sao thứ hai của một sự thật mà S2
   * không sở hữu.
   */
  logger.info(
    {
      ruleId,
      sessionId: token.sessionId,
      version: token.version,
      reason: input.reason,
    },
    "Rollout đã ramp trọng số",
  );
  return result;
}

/**
 * I23 + T12: bên gọi phải ĐANG giữ lease của đúng session đang giữ đúng rule
 * này, với đúng version hiện tại.
 *
 * Mọi thất bại đều là 412, vì với bên gọi chúng cùng một nghĩa: "anh không còn
 * là bên được quyền ghi — DỪNG". §7.1 xử lý nó bằng đúng một dòng `return`.
 * Thông điệp vẫn nói rõ vì sao, cho người vận hành đọc log.
 *
 * Version phải BẰNG (§7.3), không phải "không nhỏ hơn": một version lớn hơn cái
 * đang lưu là trạng thái không thể có, và nhận nó là tin một con số bên gọi tự
 * khai. BẰNG thì nhận — kể cả lần thứ hai: executor thử lại với backoff (§7.6)
 * mang đúng `If-Match` cũ, và lần trước có thể đã commit mà phản hồi mất trên
 * đường về.
 *
 * Bảo đảm có được là bảo đảm chuẩn của fencing token: một khi Service 2 đã nhận
 * một lần ghi mang version mới, mọi lần ghi mang version cũ hơn đều bị từ chối.
 * Nó KHÔNG tuần tự hoá lần ghi với truy vấn claim của Service 3 — việc đó cần
 * khoá hàng session, tức quyền UPDATE mà I22 không cho `udp_s2` (xem `leaseOf`).
 * Một lần ghi đã qua phép kiểm vẫn có thể commit ngay sau một lần claim; worker
 * mới thì chỉ ghi được SAU nó, vì cùng xếp hàng sau khoá environment.
 */
async function assertFencing(
  tx: Prisma.TransactionClient,
  ruleId: string,
  token: FencingToken,
): Promise<void> {
  const lease = await repository.leaseOf(tx, token.sessionId);
  const reject = (why: string): PreconditionFailedError =>
    new PreconditionFailedError(
      `Fencing đã chặn: ${why}`,
      undefined,
      "PRECONDITION_FAILED",
    );

  if (lease === null) throw reject("không có rollout session này");
  if (lease.targetingRuleId !== ruleId) {
    throw reject("session không giữ rule này");
  }
  if (!ACTIVE_ROLLOUT_STATUSES.some((s) => s === lease.status)) {
    throw reject(`session đã ${lease.status}`);
  }
  if (!lease.leased) throw reject("lease đã hết hạn");
  if (lease.version !== token.version) {
    throw reject(
      `version ${String(token.version)} không khớp version hiện tại ${String(lease.version)}`,
    );
  }
}

/** Ramp đổi TRỌNG SỐ, không đổi tập variant */
function assertSameVariants(
  current: readonly string[],
  next: readonly string[],
): void {
  const a = [...current].sort();
  const b = [...next].sort();
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
    throw new UnprocessableError(
      "Ramp chỉ được đổi TRỌNG SỐ, không được đổi tập variant của rule",
    );
  }
}
