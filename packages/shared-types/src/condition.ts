import { CONDITION_LIMITS as L } from "@udp/config/constants";
import { z } from "zod";

/**
 * Nửa "AI KHỚP" của một targeting rule (§2.2 `FlagTargetingRule.condition`) và
 * điều kiện của Segment.
 *
 * Ở package dùng chung vì hai bên cùng phải hiểu nó GIỐNG HỆT nhau: Service 2
 * validate lúc ghi, và evaluator (SDK của khách, OFREP) đọc nó lúc đánh giá
 * (I26). Hai bộ schema song song thì một rule được S2 nhận có thể bị SDK hiểu
 * khác.
 *
 * [v4.6] Hai chế độ của CÙNG một định nghĩa (§6.5):
 *   - GHI — mọi giới hạn (`CONDITION_LIMITS`), kể cả cú pháp an toàn của regex.
 *     S2 từ chối lúc lưu.
 *   - ĐỌC — chỉ hình dạng và kiểu của `value` theo toán tử. Evaluator dùng bản này
 *     để một giới hạn siết chặt về sau không biến rule đã lưu thành "hỏng" ở SDK.
 */

/**
 * Bốn loại rule — PHẢI trùng enum `RuleType` của Prisma.
 *
 * Package này không được import `@udp/db` (vòng phụ thuộc `db → shared-types →
 * db`), nên danh sách này là bản thứ hai của enum đó. Hai danh sách không gì so
 * với nhau là đúng hình dạng của lỗi PAUSED ở v3 — nên có một test ở
 * `design-lint` so hai bên, vì chỉ package đó được thấy cả hai.
 */
export const RULE_TYPES = [
  "ALL",
  "USER_BASED",
  "ATTRIBUTE_BASED",
  "SEGMENT",
] as const;

export type RuleType = (typeof RULE_TYPES)[number];

/** Mười bốn toán tử của §2.2 — thứ tự không mang nghĩa */
export const ATTRIBUTE_OPERATORS = [
  "eq",
  "neq",
  "in",
  "nin",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "startsWith",
  "endsWith",
  "semverGt",
  "semverLt",
  "regex",
] as const;

export type AttributeOperator = (typeof ATTRIBUTE_OPERATORS)[number];

// ------------------------------------------------------------- semver

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/**
 * Phiên bản SemVer 2.0 đã tách. Các số giữ dạng CHUỖI không số 0 đứng đầu: SemVer
 * không giới hạn độ lớn, và `Number("99999999999999999999")` làm tròn — hai phiên
 * bản khác nhau sẽ so bằng nhau.
 */
export interface Semver {
  core: [string, string, string];
  /** Định danh prerelease; rỗng = bản phát hành */
  pre: string[];
}

/** SemVer 2.0 đúng regex chính thức (semver.org); không nhận tiền tố `v` */
export function parseSemver(text: string): Semver | undefined {
  const m = SEMVER.exec(text);
  if (m === null) return undefined;
  const [, major, minor, patch, pre] = m;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return {
    core: [major, minor, patch],
    pre: pre === undefined ? [] : pre.split("."),
  };
}

const NUMERIC = /^(0|[1-9]\d*)$/;

/** So hai chuỗi số không có số 0 đứng đầu — theo độ dài rồi theo chữ */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifier(a: string, b: string): number {
  const an = NUMERIC.test(a);
  const bn = NUMERIC.test(b);
  if (an && bn) return compareDigits(a, b);
  // Định danh số luôn thấp hơn định danh chữ-số (SemVer 2.0 §11.4.3)
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Thứ tự ưu tiên SemVer 2.0 §11: build metadata không tham gia */
export function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i += 1) {
    const c = compareDigits(a.core[i] as string, b.core[i] as string);
    if (c !== 0) return c;
  }
  // Bản có prerelease THẤP hơn bản phát hành cùng lõi
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length === b.pre.length) return 0;
    return a.pre.length === 0 ? 1 : -1;
  }
  const n = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i += 1) {
    const c = compareIdentifier(a.pre[i] as string, b.pre[i] as string);
    if (c !== 0) return c;
  }
  if (a.pre.length === b.pre.length) return 0;
  return a.pre.length < b.pre.length ? -1 : 1;
}

// ------------------------------------------------------------- regex

const LOOKAROUND = ["=", "!", "<=", "<!"] as const;

/**
 * Lỗi CÚ PHÁP của một pattern `regex`, hoặc `undefined`.
 *
 * Tầng này chạy cả trong SDK của khách, nên chỉ làm thứ rẻ và tất định: biên dịch
 * với cờ `u`, cấm backreference và lookaround — hai tính năng đưa regex ra khỏi
 * lớp ngôn ngữ chính quy, và là nguồn của những ca backtracking tệ nhất. Phân
 * tích ReDoS thật (lượng từ lồng, alternation chồng lấn) do Service 2 làm ở
 * đường GHI (§6.5, §12); lúc đánh giá, trần `regexInputMax` chặn phần còn lại.
 */
export function regexSyntaxIssue(pattern: string): string | undefined {
  /**
   * [v4.6] Pattern phải ĐÃ ở dạng NFC: thứ được kiểm phải đúng là thứ được chạy.
   * Context được chuẩn hoá NFC trước khi so (§6.5), nên pattern NFD không bao
   * giờ khớp như người viết tưởng; và chuẩn hoá hộ lúc dựng snapshot thì đổi
   * NGỮ NGHĨA pattern — `(e\u0301|\u00e9)*` an toàn thành `(é|é)*` backtracking
   * hàm mũ, `[a\u0323-\u036f]` thành một khoảng ngược không biên dịch được.
   */
  if (pattern !== pattern.normalize("NFC")) {
    return "pattern phải ở dạng Unicode NFC";
  }
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      if (!inClass && (/[1-9]/.test(next) || next === "k")) {
        return "không hỗ trợ backreference";
      }
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(" && pattern[i + 1] === "?") {
      const tail = pattern.slice(i + 2);
      if (LOOKAROUND.some((l) => tail.startsWith(l))) {
        return "không hỗ trợ lookahead/lookbehind";
      }
    }
  }
  try {
    new RegExp(pattern, "u");
  } catch (err) {
    return `pattern không biên dịch được: ${err instanceof Error ? err.message : String(err)}`;
  }
  return undefined;
}

// ------------------------------------------------------------- điều kiện thuộc tính

const finite = z.number().finite();

/**
 * Điều kiện thuộc tính — union phân biệt theo `operator`, mỗi toán tử đúng MỘT
 * kiểu `value` (§6.5 [v4.6]). Bản trước nhận mọi kiểu cho mọi toán tử: `gt` với
 * một mảng, `regex` với một số, `semverGt` với "abc" đều lưu được, và evaluator
 * phải đoán nghĩa của chúng.
 */
function attributeConditionSchemaOf(write: boolean) {
  const str = write ? z.string().max(L.stringValueMax) : z.string();
  const nonEmpty = write
    ? z.string().min(1).max(L.stringValueMax)
    : z.string().min(1);
  /**
   * `__proto__` bị từ chối: trên object thường, gán khoá đó ĐỔI prototype thay vì
   * tạo thuộc tính — `z.record` bỏ nó khỏi context, nên một điều kiện trên nó
   * không bao giờ khớp ở đâu cả.
   */
  const attribute = (
    write ? z.string().min(1).max(L.attributeMaxLength) : z.string().min(1)
  ).refine((a) => a !== "__proto__", "tên thuộc tính không hợp lệ");
  const list = write
    ? z.array(str).min(1).max(L.inValuesMax)
    : z.array(z.string()).min(1);
  const semver = z
    .string()
    .refine((v) => parseSemver(v) !== undefined, "không phải SemVer 2.0");
  const pattern = (
    write ? z.string().min(1).max(L.regexPatternMax) : z.string().min(1)
  ).superRefine((v, ctx) => {
    const issue = regexSyntaxIssue(v);
    if (issue !== undefined) ctx.addIssue({ code: "custom", message: issue });
  });
  const scalar = z.union([str, finite, z.boolean()]);

  const of = <O extends AttributeOperator, V extends z.ZodTypeAny>(
    operator: O,
    value: V,
  ) => z.object({ attribute, operator: z.literal(operator), value }).strict();

  return z.discriminatedUnion("operator", [
    of("eq", scalar),
    of("neq", scalar),
    of("in", list),
    of("nin", list),
    of("gt", finite),
    of("gte", finite),
    of("lt", finite),
    of("lte", finite),
    of("contains", nonEmpty),
    of("startsWith", nonEmpty),
    of("endsWith", nonEmpty),
    of("semverGt", semver),
    of("semverLt", semver),
    of("regex", pattern),
  ]);
}

export const attributeConditionSchema = attributeConditionSchemaOf(true);
export const readAttributeConditionSchema = attributeConditionSchemaOf(false);
export type AttributeCondition = z.infer<typeof readAttributeConditionSchema>;

// ------------------------------------------------------------- condition theo ruleType

function conditionSchemasOf(write: boolean) {
  const conditions = z
    .array(write ? attributeConditionSchema : readAttributeConditionSchema)
    .min(1);
  return {
    ALL: z.object({}).strict(),

    USER_BASED: z
      .object({
        userIds: write
          ? z
              .array(z.string().min(1).max(L.userIdMaxLength))
              .min(1)
              .max(L.userIdsMax)
          : z.array(z.string()).min(1),
      })
      .strict(),

    // AND của nhiều điều kiện (§2.2)
    ATTRIBUTE_BASED: z
      .object({ all: write ? conditions.max(L.conditionsPerRule) : conditions })
      .strict(),

    SEGMENT: z.object({ segmentId: z.string().uuid() }).strict(),
  } as const satisfies Record<RuleType, z.ZodTypeAny>;
}

/**
 * Schema `condition` theo từng `rule_type` — đúng §2.2, cộng thêm `.strict()`.
 *
 * `.strict()` lệch khỏi §2.2 theo hướng chặt hơn, cùng khuôn `flagServeUnion`:
 * không có nó, `{ userIds: [...], segmentId }` gửi nhầm vào một rule `USER_BASED`
 * parse thành công và `segmentId` bị nuốt im lặng.
 */
export const conditionSchemas = conditionSchemasOf(true);
/** Bản ĐỌC của evaluator — cùng hình dạng, không giới hạn kích thước */
export const readConditionSchemas = conditionSchemasOf(false);

/**
 * Lỗi của `condition` so với schema GHI của `ruleType`, hoặc `undefined`.
 *
 * Trả chuỗi thay vì ném, để bên gọi gắn lỗi vào đúng đường dẫn của rule trong
 * request (`rules.3.condition`) — người sửa một danh sách hai mươi rule cần biết
 * rule NÀO sai, không chỉ "có rule sai".
 */
export function conditionIssue(
  ruleType: RuleType,
  condition: unknown,
): string | undefined {
  const result = conditionSchemas[ruleType].safeParse(condition);
  if (result.success) return undefined;

  return result.error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ` : "") + i.message)
    .join("; ");
}

// ------------------------------------------------------------- segment

/**
 * `Segment.conditions` [v4.6] — MỘT hình dạng cho §2.2, §6.5 và dây §9 (trước đó
 * ba nơi nói ba hình khác nhau). Khớp ⇔ `userIds` chứa `targetingKey` HOẶC
 * (`all` KHÔNG rỗng VÀ mọi điều kiện đúng). "Không rỗng" là sửa lỗi của §6.5 cũ:
 * `[].every(...)` là `true`, nên một segment không điều kiện từng khớp mọi người.
 */
export const segmentConditionsSchema = z
  .object({
    all: z.array(attributeConditionSchema).max(L.conditionsPerRule),
    userIds: z
      .array(z.string().min(1).max(L.userIdMaxLength))
      .max(L.userIdsMax),
  })
  .strict()
  .refine(
    (s) => s.all.length > 0 || s.userIds.length > 0,
    "Segment phải có ít nhất một điều kiện hoặc một userId",
  );

/** Bản ĐỌC: segment cả hai rỗng vẫn đọc được — nó khớp không ai */
export const readSegmentConditionsSchema = z
  .object({
    all: z.array(readAttributeConditionSchema),
    userIds: z.array(z.string()),
  })
  .strict();
export type SegmentConditions = z.infer<typeof readSegmentConditionsSchema>;
