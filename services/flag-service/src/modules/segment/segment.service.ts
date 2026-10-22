import { createHash, randomUUID } from "node:crypto";
import { SEGMENT } from "@udp/config";
import type { Prisma } from "@udp/db";
import { canonicalJson } from "@udp/flag-evaluator";
import { segmentPayloadBytesOf, segmentStateFor } from "@udp/flag-snapshot";
import {
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  UnprocessableError,
  type AuditContext,
} from "@udp/http";
import { readSegmentConditionsSchema } from "@udp/shared-types";
import { recordAudit } from "../../core/audit.js";
import { prisma } from "../../core/db.js";
import { writeConfigChange } from "../../core/outbox.js";
import { environmentIdsOf } from "../flag/flag.repository.js";
import { assertConditionsSafe } from "../rule/regex-safety.js";
import * as repository from "./segment.repository.js";
import type {
  CreateSegmentInput,
  SegmentConditions,
  SegmentStamp,
  UpdateSegmentInput,
} from "./segment.types.js";

/**
 * Nghiệp vụ segment (§2.2, §6.5, L6).
 *
 * Segment thuộc PROJECT, không thuộc environment — và snapshot của MỌI
 * environment chứa MỌI segment của project, không lọc theo tham chiếu
 * (`snapshot-row.ts`). Nên cả ba thao tác (tạo, sửa, xoá) fan-out tới TẤT CẢ
 * environment của project. Làm hẹp hơn — chỉ environment "có rule dùng segment"
 * — gây hai lỗi cùng lúc (R02):
 *
 *   (a) `config_hash` của các environment còn lại mô tả trạng thái CŨ. Replica so
 *       mỗi 60 giây sẽ lệch liên tục, ngắt mạch tầng delta rồi lặp lại vĩnh viễn.
 *   (b) Tệ hơn: `prod` chưa có rule nào dùng segment S nên không nhận delta khi S
 *       đổi; sau đó một rule PUT ở `prod` bắt đầu trỏ tới S, mà delta của
 *       `rule.replaced` chỉ mang entry flag — SDK đánh giá bằng điều kiện CŨ của S
 *       cho tới lần resync kế tiếp. Nhắm sai người dùng ở production.
 *
 * Thứ tự của mỗi thao tác là: việc tốn CPU trước transaction, mọi phép đọc cần
 * nhất quán trong `mutate`.
 */

const NOT_FOUND = "Không tìm thấy segment";

/**
 * Khử trùng `userIds`, GIỮ thứ tự lần đầu xuất hiện (V13).
 *
 * Trước mọi phép đo và trước khi ghi: trần dung lượng nói về thứ sẽ được LƯU, và
 * một danh sách gửi lên có 10 000 phần tử trùng nhau chỉ chiếm chỗ của một.
 */
const dedupe = (conditions: SegmentConditions): SegmentConditions => ({
  all: conditions.all,
  userIds: [...new Set(conditions.userIds)],
});

/**
 * View audit của một segment (V13): `{name, description, all, userIdCount,
 * userIdsSha256}`.
 *
 * KHÔNG bao giờ mang `userIds` nguyên văn. Danh sách đó tới 10 000 định danh
 * người dùng thật (email, uuid) và `audit_logs` là bảng append-only giữ vĩnh
 * viễn: ghi nó vào đây là nhân bản dữ liệu cá nhân sang một nơi không ai xoá
 * được. `userIdsSha256` vẫn trả lời được câu hỏi mà sổ kiểm toán cần — "lần sửa
 * này có đổi tập người dùng không" — vì hai tập khác nhau cho hai hash khác nhau.
 */
function auditView(
  name: string,
  description: string | null,
  conditions: SegmentConditions,
): Record<string, unknown> {
  return {
    name,
    description,
    all: conditions.all,
    userIdCount: conditions.userIds.length,
    userIdsSha256: createHash("sha256")
      .update(canonicalJson(conditions.userIds))
      .digest("hex"),
  };
}

/** `conditions` đã lưu (JSONB) về lại hình dạng của schema — CHECK ở database giữ hình */
const storedConditions = (raw: Prisma.JsonValue): SegmentConditions =>
  readSegmentConditionsSchema.parse(raw);

/**
 * Phần việc TỐN CPU và phần việc không cần nhất quán, chạy TRƯỚC transaction.
 *
 * Phân tích ReDoS ở đây chứ không trong `mutate` là chốt riêng của design:3574,
 * và nó không phải tối ưu: tới `regexPatternsPerWrite` pattern × 1 giây trong lúc
 * giữ khoá MỌI environment của project sẽ chặn mọi lần ghi flag và kill-switch
 * của Service 3, rồi ăn hết `TRANSACTION_BUDGET.timeout` 20 giây và ra P2028 —
 * lúc đó Service 1 đã chờ 30 giây và trả 503 trong khi Service 2 có thể đã commit
 * (R07 (b)).
 *
 * Trần TỪNG segment cũng xét ở đây, ngoài khoá: một segment mà bản thân nó đã lớn
 * hơn trần TỔNG của project thì không có trạng thái nào của project làm nó lưu
 * được (§16 (e): userId toàn ký tự BMP 3 byte ở trần schema là 7 710 022 B). Nói
 * "vượt trần" ngay còn hơn khoá mọi environment lại rồi mới nói.
 */
async function prepare(
  conditions: SegmentConditions,
): Promise<{ conditions: SegmentConditions; json: string }> {
  const deduped = dedupe(conditions);
  const bytes = segmentPayloadBytesOf(deduped);
  if (bytes > SEGMENT.maxProjectBytes) {
    throw new UnprocessableError(
      `Segment chiếm ${String(bytes)} byte, vượt trần ${String(SEGMENT.maxProjectBytes)} byte của cả project`,
      undefined,
      "QUOTA_EXCEEDED",
    );
  }
  await assertConditionsSafe(deduped);
  return { conditions: deduped, json: canonicalJson(deduped) };
}

/** Trần TỔNG theo project, cưỡng chế dưới khoá mọi environment (V21, INV-23.10) */
function assertWithinProjectQuota(
  bytes: repository.SegmentBytes,
  allowShrink: boolean,
): void {
  if (bytes.others + bytes.next <= SEGMENT.maxProjectBytes) return;
  /**
   * Sửa làm NHỎ ĐI (hay giữ nguyên) luôn được phép, kể cả khi project đang vượt
   * trần — nếu không thì một project đã vượt (ví dụ sau khi hằng số bị hạ) không
   * còn đường nào tự gỡ: mọi lần sửa đều bị chặn, kể cả lần sửa để gỡ.
   */
  if (allowShrink && bytes.next <= bytes.current) return;
  throw new UnprocessableError(
    `Tổng dung lượng segment của project sẽ là ${String(bytes.others + bytes.next)} byte, vượt trần ${String(SEGMENT.maxProjectBytes)} byte`,
    undefined,
    "QUOTA_EXCEEDED",
  );
}

/** Id mọi environment của project — rỗng nghĩa là project không tồn tại (F8) */
async function environmentsOf(projectId: string): Promise<string[]> {
  const environmentIds = await environmentIdsOf(prisma, projectId);
  if (environmentIds.length === 0) {
    throw new NotFoundError(
      "Project không tồn tại hoặc chưa có environment nào",
    );
  }
  return environmentIds;
}

export async function create(
  input: CreateSegmentInput,
  audit: AuditContext,
): Promise<SegmentStamp> {
  const { conditions, json } = await prepare(input.conditions);
  const environmentIds = await environmentsOf(input.projectId);

  /**
   * Id sinh ở JS, không để database mặc định: `stateOf` được dựng TRƯỚC khi
   * `mutate` chạy (`writeWithOutbox` nhận nó như một tham số), nên delta của
   * `segment.updated` phải biết id từ bây giờ.
   */
  const id = randomUUID();
  let created: SegmentStamp | undefined;

  await writeConfigChange({
    environmentIds,
    changeType: "segment.updated",
    ...(audit.actorUserId === undefined
      ? {}
      : { actorUserId: audit.actorUserId }),
    mutate: async (tx) => {
      const count = await repository.countIn(tx, input.projectId);
      if (count >= SEGMENT.maxPerProject) {
        throw new UnprocessableError(
          `Project đã có ${String(count)} segment (tối đa ${String(SEGMENT.maxPerProject)})`,
          undefined,
          "QUOTA_EXCEEDED",
        );
      }
      assertWithinProjectQuota(
        await repository.payloadBytesOf(tx, input.projectId, json),
        false,
      );

      const segment = await tx.segment.create({
        data: {
          id,
          projectId: input.projectId,
          name: input.name,
          description: input.description ?? null,
          conditions,
        },
        select: { id: true, updatedAt: true },
      });
      await recordAudit(tx, input.projectId, {
        ...audit,
        action: "segment.create",
        targetType: "Segment",
        targetId: segment.id,
        after: auditView(input.name, input.description ?? null, conditions),
      });
      created = segment;
    },
    stateOf: segmentStateFor(id),
  });

  if (created === undefined) {
    throw new Error("writeWithOutbox trả về mà không chạy mutate");
  }
  return created;
}

export async function update(
  segmentId: string,
  projectId: string,
  input: UpdateSegmentInput,
  audit: AuditContext,
): Promise<SegmentStamp> {
  const { conditions, json } = await prepare(input.conditions);
  const target = await repository.targetOf(prisma, segmentId);
  if (target === null || target.projectId !== projectId) {
    throw new NotFoundError(NOT_FOUND);
  }
  const environmentIds = await environmentsOf(projectId);

  let updated: SegmentStamp | undefined;

  await writeConfigChange({
    environmentIds,
    changeType: "segment.updated",
    ...(audit.actorUserId === undefined
      ? {}
      : { actorUserId: audit.actorUserId }),
    mutate: async (tx) => {
      const fresh = await repository.targetOf(tx, segmentId);
      if (fresh === null || fresh.projectId !== projectId) {
        throw new NotFoundError(NOT_FOUND);
      }

      if (
        fresh.updatedAt.getTime() !==
        new Date(input.lastKnownUpdatedAt).getTime()
      ) {
        /**
         * `current` mang mốc và hai trường ngắn, KHÔNG mang `conditions`.
         *
         * §8.4 muốn người dùng thấy diff, nhưng `conditions` ở đây tới 4 MiB và
         * lần đọc ấy diễn ra trong lúc đang giữ khoá mọi environment của project.
         * Portal có `GET /segments/:segmentId` để lấy bản mới nhất ngay sau 409 —
         * một lượt đi về NGOÀI khoá, đổi lấy việc không giữ khoá lâu hơn vì một
         * request đã thất bại.
         */
        throw new OptimisticLockError("Segment vừa được người khác sửa", {
          updatedAt: fresh.updatedAt,
          name: fresh.name,
          description: fresh.description,
        });
      }

      const before = storedConditions(fresh.conditions);
      /**
       * So trên canonical JSON, không so từng trường: hai `conditions` cùng nội
       * dung mà khác thứ tự khoá là CÙNG một cấu hình, và coi nó là "đã đổi" thì
       * một lần đổi tên trong lúc rollout đang chạy bị chặn oan (V12).
       */
      if (canonicalJson(before) !== json) {
        const rolloutId = await repository.liveRolloutId(
          tx,
          fresh.projectId,
          segmentId,
        );
        if (rolloutId !== undefined) {
          throw new ConflictError(
            "Một rollout đang chạy giữ rule dùng segment này — đổi điều kiện lúc này là đổi nhóm canary giữa đường",
            undefined,
            "ROLLOUT_IN_PROGRESS",
          ).withResource(rolloutId);
        }
      }

      assertWithinProjectQuota(
        await repository.payloadBytesOf(tx, fresh.projectId, json, segmentId),
        true,
      );

      /**
       * `update` của Prisma, không `$executeRaw`: `@updatedAt` của schema chỉ được
       * tôn trọng trên đường đi của Prisma (R28). Một `UPDATE` thô để mốc
       * optimistic lock đứng yên, và lần ghi kế tiếp mang mốc cũ vẫn qua được phép
       * so ở trên — tức là optimistic lock im lặng ngừng hoạt động.
       */
      const segment = await tx.segment.update({
        where: { id: segmentId },
        data: {
          name: input.name,
          description: input.description,
          conditions,
        },
        select: { id: true, updatedAt: true },
      });
      await recordAudit(tx, fresh.projectId, {
        ...audit,
        action: "segment.update",
        targetType: "Segment",
        targetId: segmentId,
        before: auditView(fresh.name, fresh.description, before),
        after: auditView(input.name, input.description, conditions),
      });
      updated = segment;
    },
    stateOf: segmentStateFor(segmentId),
  });

  if (updated === undefined) {
    throw new Error("writeWithOutbox trả về mà không chạy mutate");
  }
  return updated;
}

export async function remove(
  segmentId: string,
  projectId: string,
  audit: AuditContext,
): Promise<{ id: string }> {
  const target = await repository.targetOf(prisma, segmentId);
  if (target === null || target.projectId !== projectId) {
    throw new NotFoundError(NOT_FOUND);
  }
  const environmentIds = await environmentsOf(projectId);

  await writeConfigChange({
    environmentIds,
    changeType: "segment.updated",
    ...(audit.actorUserId === undefined
      ? {}
      : { actorUserId: audit.actorUserId }),
    mutate: async (tx) => {
      const fresh = await repository.targetOf(tx, segmentId);
      if (fresh === null || fresh.projectId !== projectId) {
        throw new NotFoundError(NOT_FOUND);
      }

      const flagId = await repository.referencingFlagId(
        tx,
        projectId,
        segmentId,
      );
      if (flagId !== undefined) {
        throw new ConflictError(
          "Segment còn được một rule tham chiếu — gỡ rule đó rồi xoá lại",
          undefined,
          "SEGMENT_IN_USE",
        ).withResource(flagId);
      }

      await tx.segment.delete({ where: { id: segmentId } });
      await recordAudit(tx, projectId, {
        ...audit,
        action: "segment.delete",
        targetType: "Segment",
        targetId: segmentId,
        before: auditView(
          fresh.name,
          fresh.description,
          storedConditions(fresh.conditions),
        ),
      });
    },
    stateOf: segmentStateFor(segmentId),
  });

  return { id: segmentId };
}
