import { writeWithOutbox, type Prisma, type PrismaClient } from "@udp/db";
import { stateFor } from "@udp/flag-snapshot";
import { canonicalizeServe, flagServeDbSchema } from "@udp/shared-types";
import { errorMessage } from "../core/errors.js";
import { FenceAbortedError, type Fence } from "../reconciler/fence.js";
import { weightsFor } from "./flag-level.executor.js";

/**
 * Kill-switch trực tiếp (§7.6, I30 phần (a)) — Service 3 ghi thẳng `serve` của
 * rule khi Service 2 không phản hồi quá `rollbackRetrySeconds`.
 *
 * Đây là writer DUY NHẤT của cấu hình flag đi vòng qua Service 2, nên nó phải tự
 * làm mọi việc S2 làm cho đường ramp, và không được làm gì hơn:
 *
 *   - **Kỷ luật ADR-05**: đi qua `writeWithOutbox` của `@udp/db` (khoá environment
 *     → đổi → hash → outbox `rule.ramped`), `config_hash` và delta tính bằng CÙNG
 *     `stateFor` của `@udp/flag-snapshot` mà S2 dùng — replica S2 còn sống (hoặc
 *     hồi phục) hội tụ qua tầng 2 như với mọi lần ramp.
 *   - **Thứ tự `weights`** qua `canonicalizeServe`; trigger UDP04 chặn bản sai.
 *   - **Đẩy `flag_env_configs.updated_at`** (quyền hẹp thứ tư [v4.3]): người đang
 *     mở danh sách rule từ trước nhận 409 thay vì lưu đè baseline vừa đặt. Đẩy
 *     TĂNG NGHIÊM (`GREATEST(cũ + 1ms, now())`): `now()` là giờ BẮT ĐẦU transaction,
 *     có thể không lớn hơn mốc của một lần ghi commit ngay trước — mốc không đổi
 *     thì optimistic lock không thấy gì.
 *   - **Fencing phía database**: S2 kiểm lease trong transaction ghi của nó; ở đây
 *     không có S2, nên lần ghi trạng thái session (`record`, chứa
 *     `updateIfVersion`) chạy TRONG cùng transaction. Worker tỉnh muộn thấy 0
 *     hàng ⇒ ném ⇒ lùi luôn cả `serve`: không ghi đè rollout mà worker khác đã
 *     tiếp quản.
 *
 * Quyền của `udp_s3` đủ cho đúng những câu dưới đây và không hơn (I22, I30):
 * UPDATE `serve`, UPDATE `updated_at`, UPDATE `config_version`/`config_hash`,
 * INSERT outbox (không RETURNING — `writeWithOutbox` [v4.3]).
 */

export interface KillSwitchInput {
  fence: Fence;
  sessionId: string;
  environmentId: string;
  flagEnvConfigId: string;
  ruleId: string;
  flagKey: string;
  targetVariantId: string;
  /**
   * Tập variant của rule mà vòng này đã đọc (`FlagTarget.currentWeights`). Rule
   * đọc lại dưới khoá mang tập KHÁC ⇒ đã bị sửa ngoài rollout: không ghi đè một
   * cấu hình mà vòng này chưa từng thấy — FAILED, traffic giữ nguyên.
   */
  expectedVariantIds: readonly string[];
  percent: number;
  /**
   * Ghi trạng thái session TRONG transaction kill-switch. `false` = version đã
   * đổi (worker khác tiếp quản) ⇒ cả transaction lùi.
   */
  record: (tx: Prisma.TransactionClient) => Promise<boolean>;
}

export type KillSwitchOutcome =
  | { status: "APPLIED" }
  | { status: "STALE" }
  | { status: "FAILED"; message: string };

export interface KillSwitch {
  apply(input: KillSwitchInput): Promise<KillSwitchOutcome>;
}

export interface KillSwitchOptions {
  /** Client nối bằng `udp_s3` */
  db: PrismaClient;
  /** Tầng 3 — cùng cờ với S2 (`CHANGEFEED_NOTIFY_ENABLED`): replica S2 còn sống thức ngay */
  notify: boolean;
}

class StaleVersion extends Error {
  constructor() {
    super("updateIfVersion 0 hàng trong transaction kill-switch");
  }
}

interface RuleRow {
  serve: unknown;
}

function sameVariants(
  weights: readonly { variantId: string }[],
  expected: readonly string[],
): boolean {
  const ids = new Set(weights.map((w) => w.variantId));
  return (
    ids.size === weights.length &&
    ids.size === expected.length &&
    expected.every((id) => ids.has(id))
  );
}

export function createKillSwitch(options: KillSwitchOptions): KillSwitch {
  return {
    async apply(input) {
      input.fence.assert();
      try {
        await writeWithOutbox(options.db, {
          environmentIds: [input.environmentId],
          changeType: "rule.ramped",
          notify: options.notify,
          mutate: async (tx) => {
            // Đọc lại dưới khoá: rule có thể đã bị sửa hay xoá từ lúc vòng này đọc
            const rows = await tx.$queryRaw<RuleRow[]>`
              SELECT serve
                FROM flag_targeting_rules
               WHERE id = ${input.ruleId}::uuid
                 AND flag_env_config_id = ${input.flagEnvConfigId}::uuid
               FOR UPDATE`;
            const row = rows[0];
            if (row === undefined) {
              throw new Error("rule của session không còn trong env-config");
            }
            const current = flagServeDbSchema.parse(row.serve);
            if (current.kind !== "distribution") {
              throw new Error("rule không còn phục vụ theo phân phối");
            }
            if (!sameVariants(current.weights, input.expectedVariantIds)) {
              throw new Error(
                "tập variant của rule đã đổi từ lúc vòng này đọc — không ghi đè",
              );
            }
            const serve = canonicalizeServe({
              kind: "distribution",
              weights: weightsFor(
                input.percent,
                current.weights,
                input.targetVariantId,
              ),
            });

            const ruleUpdated = await tx.$executeRaw`
              UPDATE flag_targeting_rules
                 SET serve = ${JSON.stringify(serve)}::jsonb
               WHERE id = ${input.ruleId}::uuid`;
            const stamped = await tx.$executeRaw`
              UPDATE flag_env_configs
                 SET updated_at = GREATEST(updated_at + interval '1 millisecond', now())
               WHERE id = ${input.flagEnvConfigId}::uuid`;
            if (ruleUpdated !== 1 || stamped !== 1) {
              throw new Error(
                `kill-switch ghi ${String(ruleUpdated)} rule, ${String(stamped)} env-config — cần đúng 1 mỗi loại`,
              );
            }

            input.fence.assert();
            if (!(await input.record(tx))) throw new StaleVersion();
          },
          stateOf: stateFor(input.flagKey, {
            rolloutSessionId: input.sessionId,
          }),
        });
        return { status: "APPLIED" };
      } catch (err) {
        if (err instanceof StaleVersion) return { status: "STALE" };
        // Mất lease giữa chừng là việc của vòng reconcile, không phải "kill-switch hỏng"
        if (err instanceof FenceAbortedError) throw err;
        return { status: "FAILED", message: errorMessage(err) };
      }
    },
  };
}
