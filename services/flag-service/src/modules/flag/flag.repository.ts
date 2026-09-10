import type { Prisma } from "@udp/db";
import { BOOLEAN_VARIANTS } from "@udp/config";
import type {
  Snapshot,
  SnapshotEntry,
  SnapshotRule,
  SnapshotSegment,
} from "@udp/flag-evaluator";
import { flagServeDbSchema, type FlagServeWire } from "@udp/shared-types";
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
 * Khóa của một variant, tra theo id.
 *
 * Ném thay vì bỏ qua: trigger `UDP01` (§6.7) cưỡng chế rule chỉ trỏ variant của
 * chính flag mình, nên tra trượt nghĩa là hàng rào đó đã bị vượt qua. Trả một
 * snapshot thiếu rule đó là im lặng phục vụ sai variant cho tới khi có người để
 * ý — mà không ai để ý được, vì kết quả vẫn "hợp lệ".
 */
function variantKeyOf(
  byId: ReadonlyMap<string, string>,
  variantId: string,
  where: string,
): string {
  const key = byId.get(variantId);
  if (key === undefined) {
    throw new Error(
      `${where}: variant ${variantId} không thuộc flag này — trigger UDP01 lẽ ra ` +
        `đã chặn, nên dữ liệu trong database đã hỏng`,
    );
  }
  return key;
}

/**
 * Dịch `serve` từ hình dạng DB sang hình dạng dây: `variantId` → `variantKey`.
 *
 * Hai chi tiết không được đổi:
 *
 * - **`parse` trước khi dịch.** Cột là JSONB nên database không giữ hình dạng
 *   cho ta. Không parse ở đây thì một `serve` hỏng đi thẳng tới SDK và nổ trong
 *   tiến trình của khách hàng, ở đúng nhánh `pickVariant` tuyên bố "không tới
 *   được".
 * - **Giữ NGUYÊN thứ tự `weights`.** `pickVariant` cộng dồn theo thứ tự mảng,
 *   nên đảo nó là gán mọi người dùng sang variant khác. `.map()` giữ thứ tự;
 *   đừng thay bằng bất cứ thứ gì sắp lại.
 */
function serveOf(
  raw: unknown,
  byId: ReadonlyMap<string, string>,
  where: string,
): FlagServeWire {
  const serve = flagServeDbSchema.parse(raw);

  if (serve.kind === "variant") {
    return {
      kind: "variant",
      variantKey: variantKeyOf(byId, serve.variantId, where),
    };
  }

  return {
    kind: "distribution",
    weights: serve.weights.map((w) => ({
      variantKey: variantKeyOf(byId, w.variantId, where),
      weight: w.weight,
    })),
  };
}

function segmentOf(row: {
  id: string;
  conditions: Prisma.JsonValue;
}): SnapshotSegment {
  if (!Array.isArray(row.conditions)) {
    throw new Error(
      `Segment ${row.id}: \`conditions\` không phải mảng. §2.2 khai đây là "mảng ` +
        `điều kiện nối bằng AND", nên một hình dạng khác là dữ liệu đã hỏng`,
    );
  }
  return { id: row.id, conditions: row.conditions };
}

/**
 * Dựng snapshot của MỘT environment — đầu vào của `config_hash`, và là chính
 * payload `/sdk/config`.
 *
 * Bốn điều quyết định tính đúng của nó:
 *
 * 1. **Hình dạng là hình dạng DÂY (§9), không phải hình dạng thuận tay cho truy
 *    vấn.** `config_hash` là hợp đồng liên tiến trình: S2 ghi con số, còn SDK
 *    dựng lại snapshot từ delta đã nhận rồi tính lại và so — I15c nói "cùng từng
 *    bit". SDK chỉ có thứ nó NHẬN, nên thứ đem đi băm phải là thứ được gửi. Bản
 *    trước băm `variants[].id`, `defaultVariantId` và `envDefaultVariantId`, ba
 *    trường không bao giờ rời server, nên SDK không có cách nào tính ra con số
 *    S2 ghi — I15c hỏng bằng cấu trúc chứ không phải bằng bug.
 * 2. **Mọi truy vấn đều kèm `environmentId`.** Bất biến I14 nói SDK key của
 *    `dev` không được đọc cấu hình `prod`. Snapshot là thứ SDK nhận, nên đây
 *    chính là nơi I14 được quyết định — một `where` thiếu điều kiện env ở đây là
 *    rò rỉ toàn bộ, không phải rò rỉ một phần.
 * 3. **Hai truy vấn, không phải N và cũng không phải ba.** Hàm này chạy BÊN
 *    TRONG transaction đang giữ row lock trên `environments`. Đã đo RTT tới
 *    database là ~50ms, nên mỗi lượt đi về đều tính. `segments` lấy lồng qua
 *    `project` chứ không phải một truy vấn thứ ba, dù nó thuộc về project chứ
 *    không thuộc environment.
 * 4. **`serve` được dịch id → key ngay tại đây.** Đây là ranh giới duy nhất mà
 *    hai hình dạng gặp nhau; để việc dịch trôi xuống controller là mở đường cho
 *    hai đường dịch khác nhau ở hai endpoint.
 */
export async function snapshotOf(
  tx: Prisma.TransactionClient,
  environmentId: string,
): Promise<Snapshot> {
  const environment = await tx.environment.findUniqueOrThrow({
    where: { id: environmentId },
    select: {
      projectId: true,
      project: {
        select: {
          segments: {
            select: { id: true, conditions: true },
            orderBy: { id: "asc" },
          },
        },
      },
    },
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

  return {
    flags: flags.map((flag): SnapshotEntry => {
      /**
       * Flag đã lưu trữ vẫn có mặt, dưới dạng bia mộ (§6.5).
       *
       * Bỏ hẳn nó khỏi snapshot làm SDK trả `FLAG_NOT_FOUND` thay vì `DISABLED`
       * — với người viết ứng dụng, cái đầu nghĩa là "gõ sai tên", cái sau nghĩa
       * là "flag có thật, đang tắt". Hai câu trả lời khác nhau cho hai tình
       * huống khác nhau.
       */
      if (flag.lifecycleStatus === "ARCHIVED") {
        return { key: flag.key, archived: true };
      }

      const config = flag.envConfigs[0];
      const byId = new Map(flag.variants.map((v) => [v.id, v.key] as const));
      const where = `Flag "${flag.key}"`;

      /**
       * Override của environment thắng default của flag (§6.5:
       * `envConfig.defaultVariantId ?? flag.defaultVariantId`).
       *
       * Trên dây chỉ có MỘT trường, nên phép chọn đó phải xảy ra ở đây. Gửi cả
       * hai xuống SDK là bắt hai bản cài đặt cùng nhớ thứ tự ưu tiên — và bên
       * nào quên thì phục vụ sai default mà hash vẫn khớp.
       */
      const defaultVariantId =
        config?.defaultVariantId ?? flag.defaultVariantId;

      if (defaultVariantId === null) {
        throw new Error(
          `${where}: không có variant mặc định. §9 khai \`defaultVariantKey\` là ` +
            `bắt buộc vì đó là giá trị SDK trả khi không rule nào khớp; thiếu nó ` +
            `thì flag không đánh giá được`,
        );
      }

      return {
        key: flag.key,
        type: flag.flagType,
        isEnabled: config?.isEnabled ?? false,
        stickinessAttribute: flag.stickinessAttribute,
        variants: Object.fromEntries(
          flag.variants.map((v) => [v.key, v.value]),
        ),
        defaultVariantKey: variantKeyOf(byId, defaultVariantId, where),
        rules: (config?.rules ?? []).map((rule): SnapshotRule => ({
          id: rule.id,
          type: rule.ruleType,
          condition: rule.condition,
          serve: serveOf(rule.serve, byId, `${where} rule ${rule.id}`),
          bucketSalt: rule.bucketSalt,
          priority: rule.priority,
        })),
      };
    }),

    segments: environment.project.segments.map(segmentOf),

    /**
     * RỖNG trong lát cắt này, và đó là câu trả lời đúng — không phải chỗ trống
     * chờ lấp.
     *
     * §6.6 định nghĩa `trackedFlags` là "tập flag đang có RolloutSession
     * FLAG_LEVEL active ở environment này". Hai lý do độc lập khiến nó rỗng:
     * chưa có Service 3 nên chưa có `RolloutSession` nào, và ma trận writer
     * (§1.2) KHÔNG cấp cho `udp_s2` bất kỳ quyền nào trên `rollout_sessions` —
     * kể cả SELECT. Tập rỗng vì thế vừa đúng về nghĩa vừa là thứ duy nhất role
     * này đọc ra được.
     *
     * Nó vẫn nằm TRONG hash: §6.6 đòi tập này đi chung đường lan truyền để thừa
     * hưởng bảo đảm của ADR-05 thay vì là một kênh thứ hai phải tự kiểm. Ngày
     * nó có nguồn dữ liệu thật, nguồn đó phải là cột do S2 sở hữu — S2 phải ghi
     * được `config_hash` trong cùng transaction, mà nó chỉ ghi được cho thứ nó
     * đọc được.
     */
    trackedFlags: [],
  };
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
