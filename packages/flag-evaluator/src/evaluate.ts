import type { Evaluation } from "@udp/shared-types";
import {
  attributeOf,
  normalizeContext,
  type EvalContext,
} from "./conditions.js";
import { pickVariant } from "./distribution.js";
import {
  segmentMatcherOf,
  type PreparedFlagEntry,
  type PreparedSnapshot,
  type SegmentMatcher,
} from "./prepare.js";

/**
 * Lõi đánh giá flag (§6.5 [v4.6]) — MỘT hàm cho SDK local, OFREP và Flag
 * Evaluation Tester (I26 bằng cấu trúc).
 *
 * Thuần và không bao giờ ném (I33): không nhận `codeDefault` (OFREP không có; lớp
 * provider điền nó khi `value` vắng), không biết cache sẵn sàng hay cũ (việc của
 * provider — `PROVIDER_NOT_READY`, `stale`).
 */

/**
 * Tăng khi NGỮ NGHĨA đánh giá đổi mà snapshot không đổi — nằm trong ETag và khoá
 * cache kết quả của OFREP, để một bản S2 mới không phục vụ kết quả tính theo luật
 * cũ.
 */
export const EVALUATOR_SEMANTICS_VERSION = 1;

export interface EvaluateOptions {
  /** Kiểu ứng dụng mong đợi; khác kiểu của flag ⇒ ERROR `TYPE_MISMATCH` */
  expectedType?: string;
}

const failure = (
  errorCode: NonNullable<Evaluation["errorCode"]>,
  errorMessage: string,
): Evaluation => ({ reason: "ERROR", errorCode, errorMessage });

/**
 * Giá trị sticky (§6.4, D3): thuộc tính stickiness, VẮNG hoặc `null` thì lùi về
 * `targetingKey`. Chuỗi giữ nguyên; số hữu hạn và boolean qua `String()` của
 * ECMAScript (bản Python phải dùng đúng luật Number::toString đó); mọi thứ khác
 * ⇒ không có giá trị sticky, rule phân phối bị bỏ qua. Không tuỳ chọn nào đổi
 * được luật này — SDK và OFREP khác luật là vỡ I26.
 */
export function stickyValueOf(
  flag: Pick<PreparedFlagEntry, "stickinessAttribute">,
  context: EvalContext,
): string | undefined {
  const raw =
    attributeOf(context, flag.stickinessAttribute) ??
    attributeOf(context, "targetingKey");
  if (typeof raw === "string") return raw;
  if (
    (typeof raw === "number" && Number.isFinite(raw)) ||
    typeof raw === "boolean"
  ) {
    return String(raw);
  }
  return undefined;
}

function evaluateFlag(
  flag: PreparedFlagEntry,
  context: EvalContext,
  segments: SegmentMatcher,
): Evaluation {
  if (!flag.isEnabled) return { reason: "DISABLED" };

  const stickyValue = stickyValueOf(flag, context);
  for (const rule of flag.rules) {
    if (rule.matches === undefined || rule.serve === undefined) {
      return {
        ...failure("GENERAL", "rule hỏng trong snapshot"),
        ruleId: rule.id,
      };
    }
    const matched = rule.matches(context, segments);
    if (matched === "broken") {
      return {
        ...failure("GENERAL", "segment hỏng trong snapshot"),
        ruleId: rule.id,
      };
    }
    if (!matched) continue;

    const pick = pickVariant(rule.serve, {
      stickyValue,
      flagKey: flag.key,
      bucketSalt: rule.bucketSalt,
    });
    if (pick.kind === "no-sticky") continue;

    if (!flag.variants.has(pick.variantKey)) {
      return { ...failure("GENERAL", "orphan variant"), ruleId: rule.id };
    }
    return {
      reason: pick.kind === "distribution" ? "SPLIT" : "TARGETING_MATCH",
      value: flag.variants.get(pick.variantKey),
      variant: pick.variantKey,
      ruleId: rule.id,
    };
  }

  if (!flag.variants.has(flag.defaultVariantKey)) {
    return failure("GENERAL", "orphan default variant");
  }
  return {
    reason: "DEFAULT",
    value: flag.variants.get(flag.defaultVariantKey),
    variant: flag.defaultVariantKey,
  };
}

function evaluateNormalized(
  prepared: PreparedSnapshot,
  flagKey: string,
  context: EvalContext,
  segments: SegmentMatcher,
  options: EvaluateOptions,
): Evaluation {
  try {
    const entry = prepared.flags.get(flagKey);
    if (entry === undefined) return failure("FLAG_NOT_FOUND", "flag không có");
    if (entry.kind === "tombstone")
      return { reason: "DISABLED", archived: true };
    if (entry.kind === "broken")
      return failure("GENERAL", "flag hỏng trong snapshot");
    if (
      options.expectedType !== undefined &&
      options.expectedType !== entry.type
    ) {
      return failure("TYPE_MISMATCH", `flag có kiểu ${entry.type}`);
    }
    return evaluateFlag(entry, context, segments);
  } catch {
    return failure("GENERAL", "lỗi đánh giá");
  }
}

function contextOf(context: unknown): EvalContext {
  return typeof context === "object" &&
    context !== null &&
    !Array.isArray(context)
    ? normalizeContext(context as EvalContext)
    : {};
}

/** Đánh giá MỘT flag */
export function evaluate(
  prepared: PreparedSnapshot,
  flagKey: string,
  context: unknown,
  options: EvaluateOptions = {},
): Evaluation {
  try {
    const ctx = contextOf(context);
    return evaluateNormalized(
      prepared,
      flagKey,
      ctx,
      segmentMatcherOf(prepared, ctx),
      options,
    );
  } catch {
    return failure("GENERAL", "lỗi đánh giá");
  }
}

/**
 * Đánh giá MỌI flag của snapshot với cùng một context (bulk OFREP) — context
 * chuẩn hoá một lần, kết quả segment nhớ chung cho mọi flag. Thứ tự theo key.
 */
export function evaluateAll(
  prepared: PreparedSnapshot,
  context: unknown,
): { key: string; evaluation: Evaluation }[] {
  let ctx: EvalContext;
  try {
    ctx = contextOf(context);
  } catch {
    ctx = {};
  }
  const segments = segmentMatcherOf(prepared, ctx);
  return prepared.keys.map((key) => ({
    key,
    evaluation: evaluateNormalized(prepared, key, ctx, segments, {}),
  }));
}
