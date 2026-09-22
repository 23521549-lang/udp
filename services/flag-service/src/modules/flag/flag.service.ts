import {
  ACTIVE_ROLLOUT_STATUS_SQL,
  type FlagLifecycleStatus,
  type Prisma,
} from "@udp/db";
import { stateFor } from "@udp/flag-snapshot";
import {
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  UnprocessableError,
  type AuditContext,
} from "@udp/http";
import { recordAudit } from "../../core/audit.js";
import { prisma } from "../../core/db.js";
import { writeConfigChange } from "../../core/outbox.js";
import * as repository from "./flag.repository.js";
import type {
  CreateFlagInput,
  PublicFlag,
  UpdateFlagInput,
} from "./flag.types.js";

/**
 * Nghiệp vụ flag.
 *
 * Mọi thay đổi đi qua `writeWithOutbox` — đó là nơi duy nhất được tăng
 * `config_version`, và là lý do hàm này trông mỏng: thứ tự bốn bước của ADR-05
 * đã được `@udp/db` giữ, service chỉ nói *thay đổi gì* và *ở environment nào*.
 */

/**
 * Tạo flag.
 *
 * Chạm MỌI environment của project (§8.4), nên mỗi environment nhận một
 * `config_version` riêng và một dòng outbox riêng. `writeWithOutbox` khoá chúng
 * theo thứ tự tất định để hai lần tạo đồng thời không deadlock.
 */
export async function create(
  input: CreateFlagInput,
  audit: AuditContext,
): Promise<PublicFlag> {
  const environmentIds = await repository.environmentIdsOf(
    prisma,
    input.projectId,
  );

  if (environmentIds.length === 0) {
    throw new NotFoundError(
      "Project không tồn tại hoặc chưa có environment nào",
    );
  }

  let created: PublicFlag | undefined;

  await writeConfigChange({
    environmentIds,
    changeType: "flag.created",
    ...actorOf(audit),
    mutate: async (tx) => {
      const flag = await repository.createFlag(tx, input, environmentIds);
      await recordAudit(tx, input.projectId, {
        ...audit,
        action: "flag.create",
        targetType: "FeatureFlag",
        targetId: flag.id,
        after: auditView(flag),
      });
      created = flag;
    },
    stateOf: stateFor(input.key),
  });

  if (created === undefined) {
    throw new Error("writeWithOutbox trả về mà không chạy mutate");
  }

  return created;
}

/**
 * Sửa định nghĩa flag, có optimistic lock.
 *
 * §2.2 dùng `FeatureFlag.updated_at` làm mốc — bảng không có cột `version`
 * riêng. So sánh nằm TRONG transaction, sau khi hàng đã bị khoá bởi bước 1 của
 * outbox writer; đặt nó ngoài transaction là để lại đúng khe hở mà optimistic
 * lock sinh ra để đóng.
 *
 * Trả 409 kèm bản mới nhất là chủ đích của §8.4: người dùng cần thấy diff để
 * quyết định, chứ không chỉ biết mình đã thua cuộc.
 */
export async function update(
  flagId: string,
  input: UpdateFlagInput,
  audit: AuditContext,
): Promise<PublicFlag> {
  const current = await repository.findById(prisma, flagId);
  if (current === null) throw new NotFoundError("Không tìm thấy flag");

  const environmentIds = await repository.environmentIdsOf(
    prisma,
    current.projectId,
  );
  let updated: PublicFlag | undefined;

  await writeConfigChange({
    environmentIds,
    changeType: "flag.updated",
    ...actorOf(audit),
    mutate: async (tx) => {
      const fresh = await repository.findById(tx, flagId);
      if (fresh === null) throw new NotFoundError("Không tìm thấy flag");

      if (
        fresh.updatedAt.getTime() !==
        new Date(input.lastKnownUpdatedAt).getTime()
      ) {
        throw new OptimisticLockError(
          "Flag đã bị người khác sửa từ lúc bạn mở nó",
          fresh,
        );
      }
      assertLifecycleTransition(fresh.lifecycleStatus, input.lifecycleStatus);
      await assertNoLiveRolloutChange(tx, fresh, input);

      const next = await tx.featureFlag.update({
        where: { id: flagId },
        data: {
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          ...(input.lifecycleStatus === undefined
            ? {}
            : { lifecycleStatus: input.lifecycleStatus }),
          ...(input.stickinessAttribute === undefined
            ? {}
            : { stickinessAttribute: input.stickinessAttribute }),
        },
        select: repository.PUBLIC_FIELDS,
      });
      await recordAudit(tx, fresh.projectId, {
        ...audit,
        action: "flag.update",
        targetType: "FeatureFlag",
        targetId: flagId,
        before: auditView(fresh),
        after: auditView(next),
      });
      updated = next;
    },
    stateOf: stateFor(current.key),
  });

  if (updated === undefined)
    throw new Error("writeWithOutbox trả về mà không chạy mutate");
  return updated;
}

/** `actorUserId` cho outbox — cùng người với hàng audit */
const actorOf = (audit: AuditContext): { actorUserId?: string } =>
  audit.actorUserId === undefined ? {} : { actorUserId: audit.actorUserId };

/**
 * Trường của flag mà một thao tác có thể đổi — before/after của audit. Tên
 * `defaultVariant` chứ không `...Key`/`...Id` nguyên văn: `redact()` che mọi khoá
 * kết thúc bằng "key", và audit mà che mất variant mặc định thì vô dụng.
 */
function auditView(flag: PublicFlag): Record<string, unknown> {
  return {
    key: flag.key,
    description: flag.description,
    lifecycleStatus: flag.lifecycleStatus,
    stickinessAttribute: flag.stickinessAttribute,
    defaultVariant: flag.defaultVariantId,
  };
}

/**
 * [v4.5] Máy trạng thái §6.7: DRAFT → ACTIVE (kích hoạt), DRAFT → ARCHIVED (bỏ
 * dở — Cleanup Center lưu trữ `STALE_DRAFT`), ACTIVE ⇄ ARCHIVED (lưu trữ, khôi
 * phục). KHÔNG quay về DRAFT: DRAFT là "SDK chưa nhận, `flag_type` còn đổi được",
 * mà một flag đã từng ACTIVE thì code của khách đã đọc nó với đúng kiểu đó.
 */
const LIFECYCLE_TRANSITIONS: Readonly<
  Record<FlagLifecycleStatus, readonly FlagLifecycleStatus[]>
> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["ARCHIVED"],
  ARCHIVED: ["ACTIVE"],
};

function assertLifecycleTransition(
  from: FlagLifecycleStatus,
  to: FlagLifecycleStatus | undefined,
): void {
  if (to === undefined || to === from) return;
  if (!LIFECYCLE_TRANSITIONS[from].includes(to)) {
    throw new UnprocessableError(
      `Không chuyển được vòng đời ${from} → ${to} (§6.7)`,
    );
  }
}

/**
 * [v4.5] Đổi vòng đời hay `stickinessAttribute` khi flag còn rollout sống ⇒ 409
 * `ROLLOUT_IN_PROGRESS` kèm rollout đang giữ. Lưu trữ: snapshot biến flag thành
 * bia mộ (tắt ở MỌI env) — rollout đang đo một flag đã tắt; mọi đổi vòng đời khác
 * cũng chặn để luật đơn giản và không phụ thuộc trạng thái xuất phát. Đổi
 * stickiness: băm lại toàn bộ người dùng giữa rollout — nhóm canary và đối chứng
 * đổi người, phép đo mất nghĩa. Kiểm TRONG khoá environment (bước 1 của
 * `writeConfigChange` đã khoá mọi env của project), nên `track` của một rollout
 * mới — cũng chạy dưới khoá env — không chen vào giữa được.
 */
async function assertNoLiveRolloutChange(
  tx: Prisma.TransactionClient,
  fresh: PublicFlag,
  input: UpdateFlagInput,
): Promise<void> {
  const changesLifecycle =
    input.lifecycleStatus !== undefined &&
    input.lifecycleStatus !== fresh.lifecycleStatus;
  const reshuffles =
    input.stickinessAttribute !== undefined &&
    input.stickinessAttribute !== fresh.stickinessAttribute;
  if (!changesLifecycle && !reshuffles) return;

  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT s.id::text AS id
      FROM rollout_sessions s
      JOIN flag_env_configs c ON c.id = s.flag_env_config_id
     WHERE c.flag_id = ${fresh.id}::uuid
       AND s.status IN (${ACTIVE_ROLLOUT_STATUS_SQL})
     LIMIT 1`;
  const live = rows[0];
  if (live === undefined) return;
  throw new ConflictError(
    changesLifecycle
      ? "Flag đang có rollout chạy — kết thúc hoặc huỷ rollout trước khi đổi trạng thái vòng đời"
      : "Flag đang có rollout chạy — đổi stickinessAttribute sẽ xáo lại nhóm canary và đối chứng",
    undefined,
    "ROLLOUT_IN_PROGRESS",
  ).withResource(live.id);
}
