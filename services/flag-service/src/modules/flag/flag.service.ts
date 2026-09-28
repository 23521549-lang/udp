import type { FlagLifecycleStatus, Prisma } from "@udp/db";
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
import {
  ARCHIVE_GUARD_DAYS,
  archivableAfter,
  archiveGuardSince,
} from "../stats/archive-guard.js";
import { recentEvaluationsOf } from "../stats/stats.repository.js";
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
 *
 * [v4.9] `asOf` là SEAM, không phải tính năng: chốt archive 7 ngày có một biên
 * chính xác tới giờ, và test của biên đó không được phụ thuộc đồng hồ. Route HTTP
 * không truyền nó — production luôn là `new Date()`.
 */
export async function update(
  flagId: string,
  input: UpdateFlagInput,
  audit: AuditContext,
  asOf: Date = new Date(),
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
    /**
     * [v4.9] `flag.archived` khi đích là ARCHIVED (§3.4).
     *
     * Từ vựng `CONFIG_CHANGE_TYPES` đã có giá trị này và poller đã chiếu nó thành
     * entry bia mộ; trước #23 không writer nào ghi nó, nên một nhánh đã được kiểm
     * của đường lan truyền chưa bao giờ chạy thật (R30 (a)). Payload không đổi:
     * `stateFor(key)` vẫn trả bia mộ y như `flag.updated`.
     */
    changeType:
      input.lifecycleStatus === "ARCHIVED" ? "flag.archived" : "flag.updated",
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
      await assertNotRecentlyEvaluated(tx, fresh, input, asOf);

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
          ...(input.permanent === undefined
            ? {}
            : { permanent: input.permanent }),
        },
        select: repository.PUBLIC_FIELDS,
      });
      await recordAudit(tx, fresh.projectId, {
        ...audit,
        action: auditActionOf(fresh.lifecycleStatus, input.lifecycleStatus),
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
export const actorOf = (audit: AuditContext): { actorUserId?: string } =>
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
    permanent: flag.permanent,
    activatedAt: flag.activatedAt,
  };
}

/**
 * [v4.9] Action của hàng audit (V11).
 *
 * Bốn action mang CÙNG tập trường before/after — chỉ cái tên khác — nên "ai
 * archive flag này, lúc nào" trả lời được bằng một chỉ mục có sẵn trên
 * `(action, project_id)` thay vì phải đọc `before`/`after` của mọi `flag.update`.
 * Một PATCH vừa đổi vòng đời vừa đổi mô tả lấy action của VÒNG ĐỜI: đó là phần
 * người đọc sổ audit đi tìm.
 */
function auditActionOf(
  from: FlagLifecycleStatus,
  to: FlagLifecycleStatus | undefined,
): string {
  if (to === undefined || to === from) return "flag.update";
  if (to === "ARCHIVED") return "flag.archive";
  if (to === "ACTIVE")
    return from === "ARCHIVED" ? "flag.restore" : "flag.activate";
  return "flag.update";
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

  const live = await repository.liveRolloutIdOf(tx, fresh.id);
  if (live === undefined) return;
  throw new ConflictError(
    changesLifecycle
      ? "Flag đang có rollout chạy — kết thúc hoặc huỷ rollout trước khi đổi trạng thái vòng đời"
      : "Flag đang có rollout chạy — đổi stickinessAttribute sẽ xáo lại nhóm canary và đối chứng",
    undefined,
    "ROLLOUT_IN_PROGRESS",
  ).withResource(live);
}

/**
 * [v4.9] Chốt archive 7 ngày (§3.4, §6.7): ACTIVE → ARCHIVED bị chặn khi flag còn
 * được đánh giá trong `archiveGuardDays` ngày gần nhất.
 *
 * Bốn quyết định nằm trong mười dòng này:
 *
 *   - **Chỉ ACTIVE → ARCHIVED.** DRAFT → ARCHIVED là "bỏ dở một flag SDK chưa bao
 *     giờ nhận" (§6.7) — có hàng stats cũng không có nghĩa gì, nên không đọc bảng
 *     (AC-1.3, R30 (c)).
 *   - **Chạy SAU chốt rollout.** Một flag vừa có rollout sống vừa có lượt đánh giá
 *     phải nhận `ROLLOUT_IN_PROGRESS`: đó là lỗi người dùng sửa được ngay (kết
 *     thúc rollout), còn chốt này chỉ hết sau nhiều ngày (D1.6, BR-1.3).
 *   - **Đọc TRONG transaction đã khoá environment**, sau bước 1 của
 *     `writeConfigChange`: như vậy chốt thấy mọi lần flush đã commit trước lúc
 *     khoá. Cửa sổ mù còn lại (~75 giây số đếm đang nằm trong bộ gộp và trong
 *     provider) được CHẤP NHẬN và ghi ở §16 — cho flush giành khoá environment để
 *     "đồng bộ" là đổi một sai số vô hại lấy một nguồn deadlock (R16, R15b).
 *   - **`ConflictError` thường, không `OptimisticLockError`.** Problem chỉ mang
 *     `detail` bằng lời; `current` là trường ĐỘC QUYỀN của `OPTIMISTIC_LOCK` ở cả
 *     thiết kế lẫn `packages/http`, và Portal lấy số liệu có cấu trúc từ
 *     `archive.*` của `GET /flags/:flagId/stats` (V10).
 */
async function assertNotRecentlyEvaluated(
  tx: Prisma.TransactionClient,
  fresh: PublicFlag,
  input: UpdateFlagInput,
  asOf: Date,
): Promise<void> {
  if (
    fresh.lifecycleStatus !== "ACTIVE" ||
    input.lifecycleStatus !== "ARCHIVED"
  ) {
    return;
  }

  const recent = await recentEvaluationsOf(
    tx,
    fresh.id,
    archiveGuardSince(asOf),
  );
  if (recent.evalCount === 0) return;

  const last = recent.lastEvaluatedAt;
  throw new ConflictError(
    `Flag còn ${String(recent.evalCount)} lượt đánh giá trong ${String(ARCHIVE_GUARD_DAYS)} ngày gần nhất` +
      (last === null
        ? ""
        : ` (lần cuối khoảng ${last.toISOString()}, archive được từ ${archivableAfter(last).toISOString()} nếu từ giờ không còn lượt nào)`) +
      " — gỡ flag khỏi code của bạn trước khi lưu trữ nó",
    undefined,
    "FLAG_RECENTLY_EVALUATED",
  );
}
