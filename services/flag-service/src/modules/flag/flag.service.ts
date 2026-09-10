import { configHashOf } from "@udp/flag-evaluator";
import { ConflictError, NotFoundError } from "@udp/http";
import { writeWithOutbox } from "@udp/db";
import { prisma } from "../../core/db.js";
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

const hashOf = async (
  tx: Parameters<typeof repository.snapshotOf>[0],
  environmentId: string,
): Promise<string> =>
  configHashOf(await repository.snapshotOf(tx, environmentId));

/**
 * Tạo flag.
 *
 * Chạm MỌI environment của project (§8.4), nên mỗi environment nhận một
 * `config_version` riêng và một dòng outbox riêng. `writeWithOutbox` khoá chúng
 * theo thứ tự tất định để hai lần tạo đồng thời không deadlock.
 */
export async function create(
  input: CreateFlagInput,
  actorUserId: string | undefined,
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

  await writeWithOutbox(prisma, {
    environmentIds,
    changeType: "flag.created",
    ...(actorUserId === undefined ? {} : { actorUserId }),
    mutate: async (tx) => {
      created = await repository.createFlag(tx, input, environmentIds);
    },
    hashOf,
    payloadFor: () => ({ key: input.key, flagType: input.flagType }),
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
  actorUserId: string | undefined,
): Promise<PublicFlag> {
  const current = await repository.findById(prisma, flagId);
  if (current === null) throw new NotFoundError("Không tìm thấy flag");

  const environmentIds = await repository.environmentIdsOf(
    prisma,
    current.projectId,
  );
  let updated: PublicFlag | undefined;

  await writeWithOutbox(prisma, {
    environmentIds,
    changeType: "flag.updated",
    ...(actorUserId === undefined ? {} : { actorUserId }),
    mutate: async (tx) => {
      const fresh = await repository.findById(tx, flagId);
      if (fresh === null) throw new NotFoundError("Không tìm thấy flag");

      if (
        fresh.updatedAt.getTime() !==
        new Date(input.lastKnownUpdatedAt).getTime()
      ) {
        throw new ConflictError(
          "Flag đã bị người khác sửa từ lúc bạn mở nó",
          { current: fresh },
          "OPTIMISTIC_LOCK",
        );
      }

      updated = await tx.featureFlag.update({
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
        select: {
          id: true,
          projectId: true,
          key: true,
          flagType: true,
          lifecycleStatus: true,
          defaultVariantId: true,
          stickinessAttribute: true,
          updatedAt: true,
          variants: { select: { id: true, key: true, value: true } },
        },
      });
    },
    hashOf,
    payloadFor: () => ({ flagId, changed: Object.keys(input) }),
  });

  if (updated === undefined)
    throw new Error("writeWithOutbox trả về mà không chạy mutate");
  return updated;
}
