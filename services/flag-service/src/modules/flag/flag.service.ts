import {
  canonicalJson,
  configHashOf,
  type Snapshot,
} from "@udp/flag-evaluator";
import { ConflictError, NotFoundError } from "@udp/http";
import { writeWithOutbox, type Prisma } from "@udp/db";
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

/**
 * Delta ghi vào outbox: TOÀN BỘ entry của flag bị ảnh hưởng, ở hình dạng dây.
 *
 * §2.2 khai `payload` là "delta đầy đủ để replica cập nhật cache mà không phải
 * đọc lại toàn bộ". Bản trước ghi `{key, flagType}` cho `flag.created` và
 * `{flagId, changed: [...]}` cho `flag.updated` — cả hai đều nói *cái gì đã
 * đổi*, không nói *đổi thành gì*. Replica nhận chúng vẫn phải đọc lại toàn bộ,
 * nên tầng 2 tốn thêm một vòng database mà không nhanh hơn tầng 1; và nó trùng
 * vai tầng 3, vốn được ADR-05 khai rõ là "ĐÁNH THỨC vòng poll, không mang dữ
 * liệu". Hai tầng không thể cùng một việc.
 *
 * Áp delta = thay entry cùng `key` trong cache. Phép đó idempotent và không phụ
 * thuộc thứ tự giữa các flag — đúng thứ I15c cần để "áp N delta cho ra đúng
 * snapshot tại cùng version".
 *
 * Đi qua `canonicalJson` rồi `JSON.parse` chứ không ép kiểu thẳng, vì hai lý do
 * cộng lại: snapshot mang `unknown` ở đúng những chỗ ứng với cột JSONB nên
 * không chứng minh được với TypeScript rằng nó là JSON, và `canonicalJson` từ
 * chối đúng những giá trị `JSON.stringify` sẽ nuốt im lặng (`undefined`, số
 * không nguyên, `bigint`). Giá phải trả là một lượt tuần tự hoá cho MỘT flag.
 */
function deltaOf(snapshot: Snapshot, flagKey: string): Prisma.InputJsonValue {
  const flag = snapshot.flags.find((f) => f.key === flagKey);

  if (flag === undefined) {
    throw new Error(
      `Không tìm thấy flag "${flagKey}" trong snapshot vừa dựng — mutate và ` +
        `delta đang nói về hai thứ khác nhau`,
    );
  }

  return JSON.parse(canonicalJson({ flag })) as Prisma.InputJsonValue;
}

/**
 * Bước 3 và bước 4 của ADR-05, cả hai từ MỘT lần đọc snapshot.
 *
 * `snapshotOf` là truy vấn nặng nhất chạy dưới row-lock. Tính hash và dựng delta
 * là hai phép chiếu của cùng một trạng thái, nên đọc hai lần là trả giá đôi cho
 * cùng một thứ, ngay tại chỗ đắt nhất.
 */
const stateFor =
  (flagKey: string) =>
  async (
    tx: Parameters<typeof repository.snapshotOf>[0],
    environmentId: string,
  ): Promise<{ configHash: string; delta: Prisma.InputJsonValue }> => {
    const snapshot = await repository.snapshotOf(tx, environmentId);
    return {
      configHash: configHashOf(snapshot),
      delta: deltaOf(snapshot, flagKey),
    };
  };

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
    stateOf: stateFor(current.key),
  });

  if (updated === undefined)
    throw new Error("writeWithOutbox trả về mà không chạy mutate");
  return updated;
}
