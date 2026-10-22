import type { FlagType, Prisma } from "@udp/db";
import { stateFor } from "@udp/flag-snapshot";
import {
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  UnprocessableError,
  ValidationError,
  type AuditContext,
} from "@udp/http";
import { FLAG_VALUE_SCHEMAS } from "@udp/shared-types";
import { stableJson } from "@udp/shared-types/promote";
import { recordAudit } from "../../core/audit.js";
import { prisma } from "../../core/db.js";
import { writeConfigChange } from "../../core/outbox.js";
import * as repository from "./flag.repository.js";
import { actorOf } from "./flag.service.js";
import type { PublicFlag, ReplaceVariantsInput } from "./flag.types.js";

/**
 * [v4.11, Plan #44] Thay TOÀN BỘ danh sách variant của một flag (§9 `PUT /internal/flags/:id/variants`,
 * QĐ-1…QĐ-4 của `plan44-spec.md`).
 *
 * Variant thuộc FLAG nên thay đổi chạm MỌI environment — cùng fan-out và cùng `changeType:
 * "flag.updated"` với `update()`: snapshot đã mang variant, replica áp bằng đúng đường đó. Mọi phép
 * kiểm phụ thuộc trạng thái chạy TRONG khoá environment của bước 1, sau khi đọc lại flag — kiểm ngoài
 * khoá là chừa khe cho một rule mới trỏ vào variant sắp xoá.
 */

type Variant = PublicFlag["variants"][number];
type IncomingVariant = ReplaceVariantsInput["variants"][number];

/** Thứ phải ghi để đi từ danh sách hiện tại tới danh sách đích — hàm thuần, kiểm được không cần database */
export interface VariantPlan {
  /** Variant đang có mà body không nhắc tới */
  deletes: string[];
  /** Variant đang có đổi key hoặc giá trị; `renamed` khi key đổi */
  updates: { id: string; key: string; value: unknown; renamed: boolean }[];
  creates: { key: string; value: unknown }[];
}

export function planVariants(
  current: readonly Variant[],
  incoming: readonly IncomingVariant[],
): VariantPlan {
  const byId = new Map(current.map((v) => [v.id, v]));
  const kept = new Set<string>();
  const plan: VariantPlan = { deletes: [], updates: [], creates: [] };
  for (const [i, v] of incoming.entries()) {
    if (v.id === undefined) {
      plan.creates.push({ key: v.key, value: v.value });
      continue;
    }
    const existing = byId.get(v.id);
    if (existing === undefined) {
      throw new ValidationError(
        `variants.${String(i)}.id không phải variant của flag này`,
      );
    }
    kept.add(v.id);
    const renamed = existing.key !== v.key;
    if (renamed || stableJson(existing.value) !== stableJson(v.value)) {
      plan.updates.push({ id: v.id, key: v.key, value: v.value, renamed });
    }
  }
  plan.deletes = current.filter((v) => !kept.has(v.id)).map((v) => v.id);
  return plan;
}

export async function replaceVariants(
  flagId: string,
  input: ReplaceVariantsInput,
  audit: AuditContext,
): Promise<PublicFlag> {
  const current = await repository.findById(prisma, flagId);
  if (current === null) throw new NotFoundError("Không tìm thấy flag");
  // `flagType` không route nào đổi được, nên kiểm được trước khi khoá
  if (current.flagType === "BOOLEAN") {
    throw new UnprocessableError(
      "Flag BOOLEAN có đúng hai variant on/off do hệ thống sinh (§2.2) — không sửa được",
    );
  }
  assertValuesMatch(current.flagType, input.variants);

  const environmentIds = await repository.environmentIdsOf(
    prisma,
    current.projectId,
  );
  let replaced: PublicFlag | undefined;

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

      const plan = planVariants(fresh.variants, input.variants);
      // So theo ID, không theo key: xoá variant `a` rồi tạo variant mới cũng tên `a` là ĐỔI mặc định
      const defaultTarget = input.variants.find(
        (v) => v.key === input.defaultVariantKey,
      );
      const newDefaultKey =
        defaultTarget === undefined ||
        defaultTarget.id === fresh.defaultVariantId
          ? undefined
          : defaultTarget.key;
      if (
        plan.deletes.length + plan.updates.length + plan.creates.length === 0 &&
        newDefaultKey === undefined
      ) {
        throw new ValidationError("Danh sách variant không đổi gì");
      }

      const live = await repository.liveRolloutIdOf(tx, fresh.id);
      if (live !== undefined) {
        throw new ConflictError(
          "Flag đang có rollout chạy — nhãn ff mang key variant (§6.6), sửa variant giữa rollout làm phép đo mất nghĩa",
          undefined,
          "ROLLOUT_IN_PROGRESS",
        ).withResource(live);
      }
      await assertNotInUse(tx, fresh, plan.deletes, newDefaultKey);

      await applyPlan(tx, fresh.id, plan);
      if (newDefaultKey !== undefined) {
        const target = await tx.flagVariant.findFirstOrThrow({
          where: { flagId, key: newDefaultKey },
          select: { id: true },
        });
        await tx.featureFlag.update({
          where: { id: flagId },
          data: { defaultVariantId: target.id },
          select: { id: true },
        });
      }
      if (plan.deletes.length > 0) {
        // CUỐI CÙNG: mặc định mới đã có, nên FK `Restrict` không vướng
        await tx.flagVariant.deleteMany({
          where: { flagId, id: { in: plan.deletes } },
        });
      }
      // Chạm `updated_at` — mốc optimistic lock của lần ghi sau (§2.2)
      const next = await tx.featureFlag.update({
        where: { id: flagId },
        data: { updatedAt: new Date() },
        select: repository.PUBLIC_FIELDS,
      });
      await recordAudit(tx, fresh.projectId, {
        ...audit,
        action: "flag.variants.update",
        targetType: "FeatureFlag",
        targetId: flagId,
        before: variantsView(fresh),
        after: variantsView(next),
      });
      replaced = next;
    },
    stateOf: stateFor(current.key),
  });

  if (replaced === undefined) {
    throw new Error("writeWithOutbox trả về mà không chạy mutate");
  }
  return replaced;
}

/** Giá trị phải khớp kiểu flag (§2.2) — cùng chốt `createFlagRefine` áp lúc tạo */
function assertValuesMatch(
  flagType: FlagType,
  variants: readonly IncomingVariant[],
): void {
  const wrong = variants.filter(
    (v) => !FLAG_VALUE_SCHEMAS[flagType].safeParse(v.value).success,
  );
  if (wrong.length > 0) {
    throw new ValidationError(
      `Giá trị không khớp kiểu flag ${flagType}: ${wrong.map((v) => v.key).join(", ")}`,
    );
  }
}

/**
 * Variant sắp xoá còn được dùng ⇒ 409 `VARIANT_IN_USE` — với người gọi, ba chỗ dùng là một câu trả
 * lời: gỡ chỗ dùng rồi thử lại. Cả ba đều phải kiểm ở đây, TRƯỚC lần xoá:
 *
 * - `default_variant_id` của flag và env-config giữ variant bằng FK `Restrict` — xoá thẳng là lỗi FK
 *   thô, 500.
 * - `serve` của rule: trigger `UDP02` (I39) chỉ chạy lúc COMMIT, còn `stateOf` của
 *   `writeConfigChange` dựng snapshot NGAY sau `mutate` — một rule trỏ variant đã xoá làm bước đó ném
 *   lỗi thường trước khi trigger kịp nói (đo: 500). Phép kiểm dùng đúng biểu thức của trigger;
 *   trigger vẫn là hàng rào ở tầng database cho mọi writer khác.
 */
async function assertNotInUse(
  tx: Prisma.TransactionClient,
  flag: PublicFlag,
  deletes: readonly string[],
  newDefaultKey: string | undefined,
): Promise<void> {
  if (deletes.length === 0) return;
  const keyOf = (id: string): string =>
    flag.variants.find((v) => v.id === id)?.key ?? id;
  if (
    newDefaultKey === undefined &&
    flag.defaultVariantId !== null &&
    deletes.includes(flag.defaultVariantId)
  ) {
    throw new ConflictError(
      `Variant "${keyOf(flag.defaultVariantId)}" là mặc định của flag — chọn mặc định khác (defaultVariantKey) trong cùng lần lưu`,
      undefined,
      "VARIANT_IN_USE",
    );
  }
  const env = await tx.flagEnvConfig.findFirst({
    where: { flagId: flag.id, defaultVariantId: { in: [...deletes] } },
    select: { defaultVariantId: true },
  });
  if (env !== null && env.defaultVariantId !== null) {
    throw new ConflictError(
      `Variant "${keyOf(env.defaultVariantId)}" đang là mặc định ở một environment — bỏ override đó trước khi xoá`,
      undefined,
      "VARIANT_IN_USE",
    );
  }
  for (const id of deletes) {
    const used = await tx.$queryRaw<{ used: number }[]>`
      SELECT 1 AS used
        FROM flag_targeting_rules r
        JOIN flag_env_configs c ON c.id = r.flag_env_config_id
       WHERE c.flag_id = ${flag.id}::uuid
         AND (r.serve @> jsonb_build_object('variantId', ${id}::text)
              OR r.serve @> jsonb_build_object(
                   'weights', jsonb_build_array(jsonb_build_object('variantId', ${id}::text))))
       LIMIT 1`;
    if (used.length > 0) {
      throw new ConflictError(
        `Variant "${keyOf(id)}" đang được rule phục vụ — gỡ rule trỏ tới nó rồi thử lại`,
        undefined,
        "VARIANT_IN_USE",
      );
    }
  }
}

/**
 * Đổi key qua hai pha: đổi chỗ hai key (`a` ↔ `b`) hay tạo lại đúng key của variant sắp xoá mà ghi
 * một lượt thì đụng chỉ mục duy nhất `(flag_id, key)` ở câu đầu. Key tạm mang tiền tố `__` — schema
 * cấm tiền tố đó ở key thật (`variantKey`), nên không bao giờ trùng một key người dùng đặt.
 */
async function applyPlan(
  tx: Prisma.TransactionClient,
  flagId: string,
  plan: VariantPlan,
): Promise<void> {
  const parked = [
    ...plan.deletes,
    ...plan.updates.filter((u) => u.renamed).map((u) => u.id),
  ];
  for (const id of parked) {
    await tx.flagVariant.update({
      where: { id },
      data: { key: `__udp_tmp_${id}` },
      select: { id: true },
    });
  }
  for (const u of plan.updates) {
    await tx.flagVariant.update({
      where: { id: u.id },
      data: { key: u.key, value: u.value as Prisma.InputJsonValue },
      select: { id: true },
    });
  }
  if (plan.creates.length > 0) {
    await tx.flagVariant.createMany({
      data: plan.creates.map((c) => ({
        flagId,
        key: c.key,
        value: c.value as Prisma.InputJsonValue,
      })),
    });
  }
}

/** before/after của audit — sắp theo key để hai hàng so được bằng mắt */
const variantsView = (flag: PublicFlag): Record<string, unknown> => ({
  defaultVariant: flag.defaultVariantId,
  variants: [...flag.variants]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((v) => ({ id: v.id, key: v.key, value: v.value })),
});
