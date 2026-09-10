import { z } from "zod";
import { TOTAL_BUCKETS } from "@udp/config/constants";

/**
 * Kiểu và schema của tầng đánh giá feature flag (§6.4, §6.5).
 *
 * Import qua subpath `@udp/config/constants` chứ KHÔNG phải `@udp/config`:
 * entry chính của config chạy `envSchema.safeParse(process.env)` ngay lúc nạp
 * module và ném lỗi nếu thiếu biến. Import từ đó sẽ biến package này thành thứ
 * không nạp được khi chưa có `.env` — hỏng mọi unit test chạy trong CI, và hỏng
 * cả người ngoài muốn đọc kiểu để viết adapter.
 *
 * File này KHÔNG import gì từ `@udp/db`.
 */

// ============================================================
// serve — nửa "PHỤC VỤ GÌ" của một targeting rule (§6.4)
// ============================================================

/**
 * Union THÔ, giữ riêng ở một biến.
 *
 * Vì sao không gộp luôn với phần kiểm tổng bên dưới: `.superRefine()` trả về
 * `ZodEffects`, và `ZodEffects` **mất `.options`** cùng khả năng lồng vào một
 * `z.discriminatedUnion` khác. Ai cần duyệt các nhánh thì dùng biến này.
 */
export const flagServeUnion = z.discriminatedUnion("kind", [
  /**
   * `.strict()` ở CẢ HAI nhánh.
   *
   * Không có nó, `{ kind: "variant", variantId, weights: [...] }` parse thành
   * công và `weights` bị nuốt im lặng — Portal dựng một distribution nhưng gán
   * nhầm `kind` sẽ ghi ra một rule phục vụ 100% một variant, thay vì nhận 422.
   * Đây là file tự nhận là chốt chặn cuối cho hình dạng `serve`.
   */
  z
    .object({
      kind: z.literal("variant"),
      variantId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("distribution"),
      weights: z
        .array(
          z.object({
            variantId: z.string().uuid(),
            // 0,001% mỗi đơn vị, nên biểu diễn được canary dưới 1%
            weight: z.number().int().min(0).max(TOTAL_BUCKETS),
          }),
        )
        .min(1),
    })
    .strict(),
]);

/**
 * Schema của cột `flag_targeting_rules.serve` (JSONB).
 *
 * Kiểm tổng đặt ở CẤP UNION, không đặt trong một nhánh. Bản thiết kế trước viết
 * `.refine()` bên trong nhánh `distribution`; cách đó KHÔNG CHẠY vì `.refine()`
 * trả `ZodEffects` mà `z.discriminatedUnion` chỉ nhận `ZodObject`. Đã kiểm chứng
 * trên zod 3.25: lỗi lúc chạy "Cannot read properties of undefined (reading 'kind')".
 *
 * Đặt kiểm tổng TRONG schema chứ không ở tầng service là có chủ ý: mọi đường ghi
 * đều đi qua `parse()`, nên không đường nào lách được. Đây là chỗ tính đúng đắn
 * của §6.4 sống.
 *
 * KHÔNG BAO GIỜ sắp lại thứ tự `weights`. §6.4 nói thứ tự cố định theo `variantId`
 * để khoảng tích lũy chỉ *dịch* chứ không *đảo*; sắp lại là bốc lại nhóm người dùng
 * và làm vỡ bất biến **I1** một cách âm thầm.
 *
 * Hậu tố `Db` phân biệt với hình dạng **wire** ở §9 (`flagServeWireSchema` bên
 * dưới), vốn dùng `variantKey` thay `variantId` — nhầm hai cái là ghi sai dữ
 * liệu. Cả hai đều giữ `weights` là MẢNG: §9 trước v4.1 khai
 * `Record<string, number>`, đã sửa vì `Record` không mang được thứ tự.
 */
export const flagServeDbSchema = flagServeUnion.superRefine((serve, ctx) => {
  if (serve.kind !== "distribution") return;
  refineDistribution(
    serve.weights,
    serve.weights.map((w) => w.variantId),
    "variantId",
    ctx,
  );
});

/**
 * Hai phép kiểm của một `distribution`, tách riêng vì CÓ HAI hình dạng `serve`.
 *
 * Bản DB khóa theo `variantId`, bản wire khóa theo `variantKey`. Nội dung kiểm
 * giống hệt nhau, nên chép đôi là tạo hai nơi có thể trôi khỏi nhau — mà thứ
 * trôi ở đây không lộ ra ở kết quả, chỉ lộ ở phân bố.
 *
 * Nhận sẵn mảng `ids` thay vì một hàm trích: với `noUncheckedIndexedAccess`,
 * trích theo chỉ số bên trong sẽ đòi một `!` mà `no-non-null-assertion` cấm.
 */
function refineDistribution(
  weights: readonly { weight: number }[],
  ids: readonly string[],
  idField: "variantId" | "variantKey",
  ctx: z.RefinementCtx,
): void {
  const sum = weights.reduce((acc, w) => acc + w.weight, 0);
  if (sum !== TOTAL_BUCKETS) {
    ctx.addIssue({
      code: "custom",
      path: ["weights"],
      message: `Tổng trọng số phải bằng ${TOTAL_BUCKETS}, đang là ${sum}`,
    });
  }

  /**
   * Mỗi variant xuất hiện ĐÚNG MỘT lần.
   *
   * Bất biến I1 ("khoảng tích lũy chỉ *dịch* chứ không *đảo*") giả định điều
   * này. Với hai mục trùng, ramp của C1 không biết sửa mục nào, và evaluator
   * cộng dồn sẽ gán hai khoảng rời rạc cho cùng một variant — người dùng rơi
   * vào khoảng thứ hai vẫn thấy đúng variant đó, nên lỗi không lộ ra ở kết quả
   * mà chỉ lộ ở phân bố, tức là gần như không lộ.
   */
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      ctx.addIssue({
        code: "custom",
        path: ["weights", index, idField],
        message: `${idField} ${id} xuất hiện nhiều lần`,
      });
    }
    seen.add(id);
  }
}

/**
 * Hình dạng **wire** của `serve` (§9) — thứ SDK nhận, và thứ evaluator chạy trên.
 *
 * Khác bản DB đúng một chỗ: `variantKey` thay `variantId`. Đó là ADR-03 và I11 —
 * id nội bộ không rời server. SDK chỉ cần khóa, để tra `variants` và để gắn nhãn
 * metrics `ff = "<flagKey>=<variant>"` (§6.6).
 *
 * Vì sao có schema wire chứ không chỉ có kiểu: đây là **hợp đồng liên tiến trình**.
 * SDK parse thứ nhận được từ mạng; một `weights` tổng không đủ 100000 lọt qua sẽ
 * làm `pickVariant` ném ở đúng nhánh nó tuyên bố "không tới được". Kiểm ở biên
 * mạng rẻ hơn nhiều so với truy một lỗi trong tiến trình của khách hàng.
 */
export const flagServeWireUnion = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("variant"),
      // FlagVariant.key là VARCHAR(100)
      variantKey: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("distribution"),
      weights: z
        .array(
          z.object({
            variantKey: z.string().min(1).max(100),
            weight: z.number().int().min(0).max(TOTAL_BUCKETS),
          }),
        )
        .min(1),
    })
    .strict(),
]);

export const flagServeWireSchema = flagServeWireUnion.superRefine(
  (serve, ctx) => {
    if (serve.kind !== "distribution") return;
    refineDistribution(
      serve.weights,
      serve.weights.map((w) => w.variantKey),
      "variantKey",
      ctx,
    );
  },
);

/**
 * PHẢI là `type` alias, KHÔNG được là `interface`.
 *
 * Prisma khai cột JSONB nhận `InputJsonValue`, mà nhánh object của kiểu đó là
 * `{ readonly [k: string]: ... }`. TypeScript chỉ suy implicit index signature cho
 * **type alias**, không cho `interface`. Khai `interface` thì gán vào `serve:` báo
 * `TS2322 ... Index signature for type 'string' is missing`, và
 * `as Prisma.InputJsonValue` KHÔNG cứu được (`TS2352`, phải qua `unknown` trước).
 * Đã kiểm chứng bằng `tsc`.
 */
export type FlagServe = z.infer<typeof flagServeDbSchema>;

/** Hình dạng wire — cùng lý do `type` alias như `FlagServe` ở trên */
export type FlagServeWire = z.infer<typeof flagServeWireSchema>;

// ============================================================
// Kết quả đánh giá — hợp đồng chung của SDK và Service 2 (§6.1, §6.5)
// ============================================================

/**
 * Union đầy đủ theo chuẩn OpenFeature.
 *
 * Trước v4, `reason` được liệt kê ở ba chỗ trong thiết kế với ba tập giá trị khác
 * nhau, khiến bất biến **I26** (local evaluation và OFREP phải trả kết quả giống
 * hệt, *gồm cả `reason`*) không có định nghĩa nào để so.
 *
 * Khai đủ tám giá trị dù evaluator của UDP chỉ phát ra năm, vì kiểu phải tương
 * thích với `ResolutionDetails` của `@openfeature/server-sdk`; khai hẹp hơn chuẩn
 * là tự tạo ra một lần ép kiểu ở ranh giới.
 */
export type ResolutionReason =
  /** Flag bật, không rule nào khớp, trả default variant của environment */
  | "STATIC"
  /** Trả default variant của flag (environment chưa cấu hình riêng) */
  | "DEFAULT"
  /** Một rule khớp và phục vụ MỘT variant */
  | "TARGETING_MATCH"
  /** Một rule khớp và phục vụ theo PHÂN PHỐI (§6.4) */
  | "SPLIT"
  /** Lấy từ cache mà không đánh giá lại — do SDK phát, không phải evaluator */
  | "CACHED"
  /** Flag tắt ở environment này, hoặc đã ARCHIVED */
  | "DISABLED"
  /** Cache quá hạn nhưng vẫn dùng — do SDK phát (§6.8) */
  | "STALE"
  /** Kèm errorCode */
  | "ERROR";

/**
 * Bốn mã lỗi của tầng đánh giá. Cả bốn đều trả về code default của ứng dụng,
 * nhưng ý nghĩa vận hành hoàn toàn khác nhau (§6.1).
 */
export type ResolutionErrorCode =
  "FLAG_NOT_FOUND" | "TYPE_MISMATCH" | "PROVIDER_NOT_READY" | "GENERAL";

/** Thông tin phụ đi kèm mỗi lần đánh giá, dùng để chẩn đoán */
export interface FlagMetadata {
  envId?: string | undefined;
  /** Rule nào đã khớp — câu hỏi đầu tiên khi debug "vì sao user này thấy tính năng" */
  ruleId?: string | undefined;
  /**
   * Dữ liệu có cũ không.
   *
   * §6.5 cố ý KHÔNG phát `reason: "STALE"` mà đặt cờ này và giữ nguyên `reason`
   * thật của lần đánh giá. Lý do: người vận hành cần biết *vì sao user thấy tính
   * năng* VÀ *dữ liệu có cũ không* — gộp hai câu hỏi vào một trường thì mất một câu.
   */
  stale?: boolean | undefined;
  /** Flag đã ARCHIVED nhưng còn tombstone trong snapshot */
  archived?: boolean | undefined;
  /** Rollout đang chạy trên flag này, nếu có */
  rolloutId?: string | undefined;
}

/**
 * Kết quả một lần đánh giá flag, theo `ResolutionDetails` của OpenFeature.
 *
 * Đây là hợp đồng mà bất biến **I26** kiểm: local evaluation trong SDK và remote
 * evaluation qua OFREP phải trả về giá trị GIỐNG HỆT nhau từng trường cho cùng một
 * context. Điều kiện để I26 đúng bằng cấu trúc là cả hai bên gọi chung một hàm
 * đánh giá, chứ không phải chỉ dùng chung kiểu này.
 *
 * `variant` là trường mà đóng góp **C1** phụ thuộc: không có nó thì không gắn được
 * nhãn `ff` vào metric HTTP, và auto-rollback ở tầng flag không có dữ liệu (§6.6).
 */
export interface ResolutionDetails<T = unknown> {
  value: T;
  variant?: string | undefined;
  reason: ResolutionReason;
  errorCode?: ResolutionErrorCode | undefined;
  errorMessage?: string | undefined;
  flagMetadata?: FlagMetadata | undefined;
}

/**
 * Ngữ cảnh đánh giá do ứng dụng cung cấp.
 *
 * `targetingKey` là tên chuẩn của OpenFeature cho định danh chính, nên SDK của mọi
 * ngôn ngữ đều điền sẵn. Thuộc tính dùng để chia nhóm cấu hình được theo từng flag
 * (`FeatureFlag.stickinessAttribute`), mặc định chính là `targetingKey` (§6.4).
 */
export interface EvaluationContext {
  targetingKey?: string | undefined;
  [attribute: string]: unknown;
}
