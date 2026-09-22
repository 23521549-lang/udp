import type { FlagLifecycleStatus, Prisma } from "@udp/db";
import { BOOLEAN_VARIANTS } from "@udp/config";
import type { CreateFlagInput, PublicFlag } from "./flag.types.js";

export const PUBLIC_FIELDS = {
  id: true,
  projectId: true,
  key: true,
  flagType: true,
  description: true,
  lifecycleStatus: true,
  defaultVariantId: true,
  stickinessAttribute: true,
  updatedAt: true,
  variants: { select: { id: true, key: true, value: true } },
} as const;

/** Id mọi environment của project — tạo flag chạm TẤT CẢ (§8.4) */
export const environmentIdsOf = async (
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<string[]> =>
  (
    await tx.environment.findMany({
      where: { projectId },
      select: { id: true },
      orderBy: { id: "asc" },
    })
  ).map((e) => e.id);

/**
 * Tạo flag — BA bước, không phải một.
 *
 * `FeatureFlag.default_variant_id` là khoá ngoại trỏ `FlagVariant`, mà variant
 * lại thuộc về chính flag đang tạo. Không gán được lúc INSERT vì hàng variant
 * chưa tồn tại. Seed đã đi đúng đường này từ trước; chép lại ở đây để hai nơi
 * không lệch nhau.
 *
 * Flag sinh ra ở `DRAFT` (§8.4, và cũng là `@default` của schema). Nó chỉ thành
 * `ACTIVE` khi người dùng chủ động bật — trước đó `flag_type` còn đổi được, sau
 * đó thì không.
 */
export async function createFlag(
  tx: Prisma.TransactionClient,
  input: CreateFlagInput,
  environmentIds: readonly string[],
): Promise<PublicFlag> {
  /**
   * `BOOLEAN` tự sinh hai variant `on`/`off` (§2.2). Giá trị lấy từ
   * `BOOLEAN_VARIANTS` của `@udp/config` chứ không ghim chuỗi ở đây — hai nơi
   * viết "on" là hai nơi có thể trôi khỏi nhau.
   */
  const variants = input.variants ?? [
    { key: BOOLEAN_VARIANTS.ON, value: true },
    { key: BOOLEAN_VARIANTS.OFF, value: false },
  ];

  const flag = await tx.featureFlag.create({
    data: {
      projectId: input.projectId,
      key: input.key,
      flagType: input.flagType,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      variants: {
        create: variants.map((v) => ({
          key: v.key,
          value: v.value as Prisma.InputJsonValue,
        })),
      },
      /**
       * Một hàng `FlagEnvConfig` cho MỌI environment, tắt sẵn (§8.4).
       *
       * Thiếu hàng nào thì flag "không tồn tại" ở environment đó theo cách khó
       * hiểu nhất: Portal hiện flag, SDK trả `FLAG_NOT_FOUND`.
       */
      envConfigs: {
        create: environmentIds.map((environmentId) => ({
          environmentId,
          isEnabled: false,
        })),
      },
    },
    select: PUBLIC_FIELDS,
  });

  const defaultKey = input.defaultVariantKey ?? variants[0]?.key;
  const defaultVariant = flag.variants.find((v) => v.key === defaultKey);

  if (defaultVariant === undefined) {
    throw new Error(
      `Không tìm thấy variant mặc định "${String(defaultKey)}" vừa tạo`,
    );
  }

  return tx.featureFlag.update({
    where: { id: flag.id },
    data: { defaultVariantId: defaultVariant.id },
    select: PUBLIC_FIELDS,
  });
}

export const findById = (
  tx: Prisma.TransactionClient,
  id: string,
): Promise<PublicFlag | null> =>
  tx.featureFlag.findUnique({ where: { id }, select: PUBLIC_FIELDS });

/**
 * [v4.6] Flag cho Flag Evaluation Tester — CHỈ khi environment thuộc cùng project
 * với flag. Hai câu đơn chứ không một câu lồng quan hệ: lọc qua `project` đọc bảng
 * `projects`, thứ `udp_s2` không có quyền (§1.2).
 */
export async function testerTargetOf(
  db: Prisma.TransactionClient,
  flagId: string,
  environmentId: string,
): Promise<{ key: string; lifecycleStatus: FlagLifecycleStatus } | null> {
  const flag = await db.featureFlag.findUnique({
    where: { id: flagId },
    select: { key: true, projectId: true, lifecycleStatus: true },
  });
  if (flag === null) return null;
  const environment = await db.environment.findFirst({
    where: { id: environmentId, projectId: flag.projectId },
    select: { id: true },
  });
  return environment === null
    ? null
    : { key: flag.key, lifecycleStatus: flag.lifecycleStatus };
}
