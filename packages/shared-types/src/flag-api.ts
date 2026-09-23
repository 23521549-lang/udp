import {
  INT4_MAX,
  INT4_MIN,
  MAX_RULES_PER_ENV_CONFIG,
} from "@udp/config/constants";
import { z } from "zod";
import { conditionIssue, RULE_TYPES } from "./condition.js";
import {
  EVALUATION_REASONS,
  flagServeDbSchema,
  RESOLUTION_ERROR_CODES,
} from "./evaluation.js";
import { FLAG_TYPES, FLAG_VALUE_SCHEMAS } from "./flag-value.js";

/**
 * Hợp đồng ghi cấu hình flag (§8.4, §9) — MỘT định nghĩa cho hai biên [v4.5]:
 * biên NGOÀI của Service 1 (`/api/v1/projects/:id/flags/...`, Portal gọi) và biên
 * TRONG của Service 2 (`/internal/...`, S1 gọi). Hai bản chép là hai cách hiểu cùng
 * một request; lệch nhau thì S1 nhận thứ S2 từ chối bằng 400 — lỗi hợp đồng mà
 * người dùng không sửa được.
 *
 * Export object GỐC và hàm refine riêng, không export schema đã ghép: zod 3 không
 * `.omit`/`.extend` được schema có `superRefine`, và mỗi biên ghép khác nhau — S2
 * thêm `projectId` và `.strict()`, S1 thêm `confirmFlagKey` (xác nhận hai bước,
 * §8.4) rồi bóc nó trước khi gửi xuống.
 */

type Refine<T> = (data: T, ctx: z.RefinementCtx) => void;

export const flagKeySchema = z
  .string()
  .trim()
  .min(1, "Chưa có key")
  .max(255)
  /**
   * Key đi vào nhãn Prometheus (`ff="<key>=<variant>"`, §6.6) và vào URL của
   * SDK. Cho phép khoảng trắng hay dấu là mời một lớp lỗi thoát chuỗi ở ba nơi
   * khác nhau về sau.
   */
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "Key chỉ gồm chữ thường, số và dấu gạch ngang",
  );

/**
 * Tiền tố `__` bị từ chối [v4.9]: đó là không gian tên của nhãn stats
 * `__disabled__`/`__error__` (`sdk-stats.ts`) — một variant tên `__disabled__` sẽ
 * bị gộp với lượt DISABLED trong mọi thống kê. Cùng chốt đó chặn luôn `__proto__`:
 * variant tra theo key trong một bảng object (§9).
 */
const variantKey = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((k) => !k.startsWith("__"), "key variant không được bắt đầu bằng __");

// ------------------------------------------------------------- tạo flag

export const createFlagFields = z.object({
  key: flagKeySchema,
  /** Một danh sách cho cả hệ thống — chốt với enum Prisma ở design-lint */
  flagType: z.enum(FLAG_TYPES),
  description: z.string().trim().max(1000).optional(),
  /**
   * TUỲ CHỌN với `BOOLEAN`: §2.2 nói flag boolean tự sinh hai variant `on` và
   * `off`. Bắt người gọi khai lại hai thứ đó là mời họ khai sai.
   */
  variants: z
    .array(z.object({ key: variantKey, value: z.unknown() }))
    .min(2, "Flag phải có ít nhất hai variant")
    .optional(),
  /** Key của variant làm mặc định; thiếu thì lấy variant đầu tiên */
  defaultVariantKey: variantKey.optional(),
  /**
   * [v4.9] Flag sống lâu có chủ ý (kill-switch, cấu hình vận hành): miễn cảnh báo
   * UNUSED và SETTLED của Cleanup Center (§6.7). Chỉ ảnh hưởng cảnh báo, không
   * ảnh hưởng đánh giá, nên không cần xác nhận.
   */
  permanent: z.boolean().optional(),
});

export const createFlagRefine: Refine<z.infer<typeof createFlagFields>> = (
  data,
  ctx,
) => {
  if (data.flagType !== "BOOLEAN" && data.variants === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["variants"],
      message: "Chỉ flag BOOLEAN mới tự sinh variant; các kiểu khác phải khai",
    });
  }

  const keys = data.variants?.map((v) => v.key) ?? [];
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({
      code: "custom",
      path: ["variants"],
      message: "Key variant bị trùng",
    });
  }

  /**
   * Giá trị phải khớp kiểu flag (§2.2). Thiếu chốt này thì flag `STRING` nhận được
   * variant mang số, và lỗi chỉ lộ ra ở SDK của khách dưới dạng `TYPE_MISMATCH` —
   * xa khỏi chỗ gây ra nó, và sau khi nó đã được phục vụ cho mọi người dùng.
   */
  for (const [i, v] of (data.variants ?? []).entries()) {
    if (!FLAG_VALUE_SCHEMAS[data.flagType].safeParse(v.value).success) {
      ctx.addIssue({
        code: "custom",
        path: ["variants", i, "value"],
        message: `Giá trị không khớp kiểu flag ${data.flagType}`,
      });
    }
  }

  if (
    data.defaultVariantKey !== undefined &&
    keys.length > 0 &&
    !keys.includes(data.defaultVariantKey)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultVariantKey"],
      message: "defaultVariantKey không nằm trong danh sách variant",
    });
  }
};

// ------------------------------------------------------------- sửa flag

export const updateFlagFields = z.object({
  /**
   * Optimistic lock. §2.2 dùng `FeatureFlag.updated_at` làm mốc so sánh — bảng
   * không có cột `version` riêng. Thiếu trường này thì hai người sửa cùng lúc,
   * người lưu sau ghi đè người lưu trước mà không ai biết.
   */
  lastKnownUpdatedAt: z.string().datetime({ offset: true }),
  description: z.string().trim().max(1000).nullable().optional(),
  lifecycleStatus: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
  stickinessAttribute: z.string().trim().min(1).max(100).optional(),
  /** [v4.9] Xem `createFlagFields.permanent` */
  permanent: z.boolean().optional(),
});

/**
 * Ít nhất một trường thật sự đổi. Chỉ có `lastKnownUpdatedAt` thì vẫn là một lần
 * ghi đầy đủ: tăng `config_version` ở MỌI env của project, mỗi env một dòng outbox,
 * mọi SDK nạp lại — và một hàng audit before == after.
 */
export const updateFlagRefine: Refine<z.infer<typeof updateFlagFields>> = (
  data,
  ctx,
) => {
  if (
    data.description === undefined &&
    data.lifecycleStatus === undefined &&
    data.stickinessAttribute === undefined &&
    data.permanent === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "Phải có ít nhất một trong description, lifecycleStatus, stickinessAttribute, permanent",
    });
  }
};

// ------------------------------------------------------------- flag theo environment

export const updateEnvConfigFields = z.object({
  isEnabled: z.boolean().optional(),
  defaultVariantId: z.string().uuid().nullable().optional(),
});

export const updateEnvConfigRefine: Refine<
  z.infer<typeof updateEnvConfigFields>
> = (data, ctx) => {
  if (data.isEnabled === undefined && data.defaultVariantId === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Phải có ít nhất một trong isEnabled, defaultVariantId",
    });
  }
};

// ------------------------------------------------------------- rule

/**
 * PUT theo nghĩa "đây là TOÀN BỘ danh sách rule của env-config này" — nhưng
 * KHÔNG theo nghĩa "xoá hết rồi chèn lại". §8.4: "Sinh `bucket_salt` cho rule
 * MỚI / Rule cũ GIỮ NGUYÊN `bucket_salt` → đổi trọng số không xáo lại nhóm người
 * dùng (I1)". Nên mỗi rule mang theo danh tính của nó: có `id` là rule đang có,
 * không có `id` là rule mới.
 */
export const ruleInputSchema = z
  .object({
    /** Có ⇒ rule ĐANG CÓ: cập nhật tại chỗ, giữ `bucket_salt`. Không có ⇒ rule mới */
    id: z.string().uuid().optional(),
    ruleType: z.enum(RULE_TYPES),
    /** Kiểm theo `ruleType` ở refine bên dưới — hình dạng phụ thuộc loại */
    condition: z.unknown(),
    /** Tổng weight và tính duy nhất do schema DB kiểm; thứ tự do service ép */
    serve: flagServeDbSchema,
    /**
     * Cột là INTEGER (int4). Không chặn ở đây thì một số ngoài khoảng đi thẳng
     * xuống Postgres, ném `22003`, và thành 500 thay vì 400.
     */
    priority: z.number().int().min(INT4_MIN).max(INT4_MAX),
    description: z.string().trim().max(255).nullable().optional(),
  })
  /**
   * `.strict()` chặn đúng một thứ quan trọng: `bucketSalt`. Nhận nó từ client là
   * cho người gọi quyền xáo lại nhóm người dùng bằng một lời PUT — thứ I1 cấm.
   * Salt chỉ được sinh ở server, đúng một lần, lúc tạo rule.
   */
  .strict();

export const replaceRulesFields = z.object({
  /**
   * Optimistic lock theo `FlagEnvConfig.updated_at` (§2.2 "optimistic lock ở
   * mức env" — sửa rule ở dev không chặn người sửa prod).
   */
  lastKnownUpdatedAt: z.string().datetime({ offset: true }),
  rules: z.array(ruleInputSchema).max(MAX_RULES_PER_ENV_CONFIG),
});

export const replaceRulesRefine: Refine<z.infer<typeof replaceRulesFields>> = (
  data,
  ctx,
) => {
  for (const [i, rule] of data.rules.entries()) {
    const issue = conditionIssue(rule.ruleType, rule.condition);
    if (issue !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["rules", i, "condition"],
        message: issue,
      });
    }
  }

  const ids = data.rules.flatMap((r) => (r.id === undefined ? [] : [r.id]));
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: "custom",
      path: ["rules"],
      message: "Một rule xuất hiện hai lần trong danh sách",
    });
  }
};

// ------------------------------------------------------------- type của body

/** Body ghi đã qua schema — kiểu của lời gọi S1 → S2 (S1 thêm `projectId` khi tạo) */
export type CreateFlagFields = z.infer<typeof createFlagFields>;
export type UpdateFlagFields = z.infer<typeof updateFlagFields>;
export type UpdateEnvConfigFields = z.infer<typeof updateEnvConfigFields>;
export type ReplaceRulesFields = z.infer<typeof replaceRulesFields>;

// ------------------------------------------------------------- Flag Evaluation Tester

/**
 * [v4.6] Kết quả của Flag Evaluation Tester (§10.12) — hợp đồng S2 → S1 → Portal.
 * Parse ở S1 (không ép kiểu): S1 trả nó thẳng tới Portal, nên một lệch hợp đồng
 * phải nổ ở biên, không trôi tới người dùng.
 *
 * `rule` lấy từ CÙNG snapshot đã đánh giá — tra lại theo id ở thời điểm khác có
 * thể trả một rule đã đổi. `draft`: flag còn DRAFT — kết quả là thứ SDK SẼ thấy
 * khi flag được kích hoạt, hôm nay SDK chưa thấy gì (§6.7).
 */
export const testerResultSchema = z.object({
  evaluation: z.object({
    reason: z.enum(EVALUATION_REASONS),
    value: z.unknown().optional(),
    variant: z.string().optional(),
    errorCode: z.enum(RESOLUTION_ERROR_CODES).optional(),
    errorMessage: z.string().optional(),
    ruleId: z.string().optional(),
    archived: z.literal(true).optional(),
  }),
  rule: z
    .object({ id: z.string(), ruleType: z.string(), priority: z.number() })
    .optional(),
  configVersion: z.number().int(),
  draft: z.boolean(),
});
export type TesterResult = z.infer<typeof testerResultSchema>;
