import type { Prisma } from "@udp/db";
import { BOOLEAN_VARIANTS } from "@udp/config";
import type { SnapshotEntry } from "@udp/flag-evaluator";
import type { CreateFlagInput, PublicFlag } from "./flag.types.js";

const PUBLIC_FIELDS = {
  id: true,
  projectId: true,
  key: true,
  flagType: true,
  lifecycleStatus: true,
  defaultVariantId: true,
  stickinessAttribute: true,
  updatedAt: true,
  variants: { select: { id: true, key: true, value: true } },
} as const;

/**
 * Dựng snapshot của MỘT environment — đầu vào của `config_hash`.
 *
 * Hai điều quyết định tính đúng của nó:
 *
 * 1. **Mọi truy vấn đều kèm `environmentId`.** Bất biến I14 nói SDK key của
 *    `dev` không được đọc cấu hình `prod`. Snapshot là thứ SDK nhận, nên đây
 *    chính là nơi I14 được quyết định — một `where` thiếu điều kiện env ở đây là
 *    rò rỉ toàn bộ, không phải rò rỉ một phần.
 * 2. **Một truy vấn, không phải N.** Hàm này chạy BÊN TRONG transaction đang giữ
 *    row lock trên `environments`. Đã đo RTT tới database là ~50ms, nên duyệt
 *    flag từng cái một ở environment có trăm flag là hết ngân sách transaction
 *    và giữ khoá suốt thời gian đó.
 */
export async function snapshotOf(
  tx: Prisma.TransactionClient,
  environmentId: string,
): Promise<SnapshotEntry[]> {
  const environment = await tx.environment.findUniqueOrThrow({
    where: { id: environmentId },
    select: { projectId: true },
  });

  const flags = await tx.featureFlag.findMany({
    where: { projectId: environment.projectId },
    select: {
      key: true,
      flagType: true,
      lifecycleStatus: true,
      stickinessAttribute: true,
      defaultVariantId: true,
      variants: { select: { id: true, key: true, value: true } },
      envConfigs: {
        where: { environmentId },
        select: {
          isEnabled: true,
          defaultVariantId: true,
          rules: {
            select: {
              id: true,
              ruleType: true,
              priority: true,
              bucketSalt: true,
              condition: true,
              serve: true,
            },
          },
        },
      },
    },
  });

  return flags.map((flag): SnapshotEntry => {
    /**
     * Flag đã lưu trữ vẫn có mặt, dưới dạng bia mộ (§6.5).
     *
     * Bỏ hẳn nó khỏi snapshot làm SDK trả `FLAG_NOT_FOUND` thay vì `DISABLED` —
     * với người viết ứng dụng, cái đầu nghĩa là "gõ sai tên", cái sau nghĩa là
     * "flag có thật, đang tắt". Hai câu trả lời khác nhau cho hai tình huống
     * khác nhau.
     */
    if (flag.lifecycleStatus === "ARCHIVED") {
      return { key: flag.key, archived: true };
    }

    const config = flag.envConfigs[0];

    return {
      key: flag.key,
      flagType: flag.flagType,
      stickinessAttribute: flag.stickinessAttribute,
      defaultVariantId: flag.defaultVariantId,
      variants: flag.variants,
      isEnabled: config?.isEnabled ?? false,
      envDefaultVariantId: config?.defaultVariantId ?? null,
      rules: (config?.rules ?? []).map((rule) => ({
        id: rule.id,
        ruleType: rule.ruleType,
        priority: rule.priority,
        bucketSalt: rule.bucketSalt,
        condition: rule.condition,
        serve: rule.serve,
      })),
    };
  });
}

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
