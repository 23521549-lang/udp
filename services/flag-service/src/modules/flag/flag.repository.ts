import {
  ACTIVE_ROLLOUT_STATUS_SQL,
  type FlagLifecycleStatus,
  type Prisma,
} from "@udp/db";
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
  /** [v4.9] Kill-switch dài hạn — miễn cảnh báo UNUSED/SETTLED (§6.7) */
  permanent: true,
  // Chỉ ĐỌC: trigger `trg_flag_activated_at` đặt mốc, `update()` không ghi (§2.2)
  activatedAt: true,
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
      ...(input.permanent === undefined ? {} : { permanent: input.permanent }),
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
 * Id một rollout còn sống trên flag ở BẤT KỲ environment nào, hoặc `undefined`. Người gọi chạy nó
 * trong khoá environment của `writeConfigChange`, nên `track` của một rollout mới — cũng chạy
 * dưới khoá env — không chen vào giữa phép kiểm và lần ghi.
 */
export async function liveRolloutIdOf(
  tx: Prisma.TransactionClient,
  flagId: string,
): Promise<string | undefined> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT s.id::text AS id
      FROM rollout_sessions s
      JOIN flag_env_configs c ON c.id = s.flag_env_config_id
     WHERE c.flag_id = ${flagId}::uuid
       AND s.status IN (${ACTIVE_ROLLOUT_STATUS_SQL})
     LIMIT 1`;
  return rows[0]?.id;
}

/**
 * [v4.9] Environment có thuộc project này không — phòng thủ nhiều lớp cho tham số
 * `environmentId` của stats (R05): Service 1 đã kiểm sở hữu, S2 kiểm lại vì route
 * nội bộ không được tin mọi id nó nhận.
 */
export async function environmentInProject(
  db: Prisma.TransactionClient,
  projectId: string,
  environmentId: string,
): Promise<boolean> {
  const row = await db.environment.findFirst({
    where: { id: environmentId, projectId },
    select: { id: true },
  });
  return row !== null;
}

/** Trường của một dòng Cleanup Center — hình `items[].flag` của §3.1 */
export const STALE_CANDIDATE_FIELDS = {
  id: true,
  key: true,
  description: true,
  lifecycleStatus: true,
  flagType: true,
  permanent: true,
  createdAt: true,
  activatedAt: true,
  updatedAt: true,
} as const;

export type StaleCandidate = Prisma.FeatureFlagGetPayload<{
  select: typeof STALE_CANDIDATE_FIELDS;
}>;

/**
 * [v4.9] Ứng viên của Cleanup Center: mọi flag DRAFT và ACTIVE của project.
 *
 * ARCHIVED bị loại ngay trong câu chứ không lọc ở JS — nó không bao giờ vào danh
 * sách (§6.7: lưu trữ là trạng thái đích), và với project đã dọn dẹp nhiều thì đó
 * là phần lớn số hàng. Không phân trang ở đây: `counts` của phản hồi là số của
 * TOÀN BỘ project, nên phân trang phải xảy ra SAU khi xếp nhãn.
 */
export const staleCandidatesOf = (
  db: Prisma.TransactionClient,
  projectId: string,
): Promise<StaleCandidate[]> =>
  db.featureFlag.findMany({
    where: { projectId, lifecycleStatus: { in: ["DRAFT", "ACTIVE"] } },
    select: STALE_CANDIDATE_FIELDS,
    orderBy: { key: "asc" },
  });

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
