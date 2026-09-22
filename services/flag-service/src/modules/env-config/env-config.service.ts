import { stateFor } from "@udp/flag-snapshot";
import { NotFoundError, type AuditContext } from "@udp/http";
import { recordAudit } from "../../core/audit.js";
import { prisma } from "../../core/db.js";
import { writeConfigChange } from "../../core/outbox.js";
import * as repository from "./env-config.repository.js";
import type {
  PublicEnvConfig,
  UpdateEnvConfigInput,
} from "./env-config.types.js";

/**
 * Bật/tắt và đặt default variant cho flag ở MỘT environment (§8.4).
 *
 * Chạm đúng MỘT environment — khác `POST /flags` chạm tất cả. Nên chỉ environment
 * này tăng `config_version` và nhận dòng outbox; environment khác của cùng project
 * không bị đánh thức vô cớ. Bật flag ở `dev` mà làm mọi SDK của `prod` tải lại
 * cấu hình là trả giá cho một thay đổi không liên quan tới họ.
 *
 * `change_type` là `envconfig.toggled` cho CẢ việc đặt default variant, không chỉ
 * bật/tắt: từ vựng §2.2 là đóng và đây là mục duy nhất nói về `FlagEnvConfig`.
 * Replica không cần phân biệt, vì delta mang TOÀN BỘ entry của flag — áp vào là
 * đúng bất kể trường nào đã đổi.
 *
 * KHÔNG có optimistic lock, đúng như §9 và §8.4 (body chỉ có `{ isEnabled }`).
 * Hai trường đều là phép gán tuyệt đối chứ không phải đọc-sửa-ghi, nên người gọi
 * sau thắng là đúng nghĩa: "bật" hai lần vẫn là bật.
 */
export async function update(
  id: string,
  input: UpdateEnvConfigInput,
  audit: AuditContext,
): Promise<PublicEnvConfig> {
  const target = await repository.targetOf(prisma, id);
  if (target === null) {
    throw new NotFoundError("Không tìm thấy cấu hình flag theo environment");
  }

  let updated: PublicEnvConfig | undefined;

  await writeConfigChange({
    environmentIds: [target.environmentId],
    changeType: "envconfig.toggled",
    ...(audit.actorUserId === undefined
      ? {}
      : { actorUserId: audit.actorUserId }),
    mutate: async (tx) => {
      // Đọc lại SAU khi bước 1 đã khoá environment — xem `targetOf`
      const fresh = await repository.targetOf(tx, id);
      if (fresh === null) {
        throw new NotFoundError(
          "Không tìm thấy cấu hình flag theo environment",
        );
      }

      const next = await tx.flagEnvConfig.update({
        where: { id },
        data: {
          ...(input.isEnabled === undefined
            ? {}
            : { isEnabled: input.isEnabled }),
          ...(input.defaultVariantId === undefined
            ? {}
            : { defaultVariantId: input.defaultVariantId }),
        },
        select: repository.PUBLIC_FIELDS,
      });
      await recordAudit(tx, fresh.projectId, {
        ...audit,
        action: "flag.env.update",
        targetType: "FlagEnvConfig",
        targetId: id,
        environmentId: fresh.environmentId,
        // `defaultVariant`, không `defaultVariantId`: xem `auditView` của flag.service
        before: {
          isEnabled: fresh.isEnabled,
          defaultVariant: fresh.defaultVariantId,
        },
        after: {
          isEnabled: next.isEnabled,
          defaultVariant: next.defaultVariantId,
        },
      });
      updated = next;
    },
    stateOf: stateFor(target.flagKey),
  });

  if (updated === undefined) {
    throw new Error("writeWithOutbox trả về mà không chạy mutate");
  }
  return updated;
}
