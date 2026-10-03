import { OFREP } from "@udp/config/constants";
import { z } from "zod";

/**
 * Hợp đồng dây của OFREP — OpenFeature Remote Evaluation Protocol (§6.2, ADR-03)
 * [v4.6], theo `service/openapi.yaml` của open-feature/protocol.
 *
 * Ở package dùng chung vì hai bên đọc cùng một hình: Service 2 phát, và test I26
 * (sau này là provider) đọc ngược về `Evaluation` qua `fromOfrep`.
 */

/** Enum ĐÓNG của OFREP — không có DEFAULT (xem `toOfrep`) */
export type OfrepReason =
  "STATIC" | "TARGETING_MATCH" | "SPLIT" | "DISABLED" | "UNKNOWN";

/** Lỗi của MỘT flag — phần tử bulk hoặc 400 của endpoint đơn */
export type OfrepEvaluationErrorCode =
  "PARSE_ERROR" | "TARGETING_KEY_MISSING" | "INVALID_CONTEXT" | "GENERAL";

/** Giá trị metadata OFREP cho phép: chỉ nguyên thuỷ */
export type OfrepMetadata = Record<string, boolean | string | number>;

/**
 * Đánh giá thành công. Vắng `value` = `codeDefaultFlag`: ứng dụng dùng default
 * trong code của nó — đúng nghĩa DISABLED của UDP (§6.5).
 */
export interface OfrepSuccess {
  key: string;
  reason: OfrepReason;
  value?: unknown;
  variant?: string;
  metadata?: OfrepMetadata;
}

export interface OfrepFailure {
  key: string;
  errorCode: OfrepEvaluationErrorCode;
  errorDetails?: string;
}

/** 404 của endpoint đơn — hình RIÊNG, bulk không bao giờ phát mã này */
export interface OfrepFlagNotFound {
  key: string;
  errorCode: "FLAG_NOT_FOUND";
  errorDetails?: string;
}

export interface OfrepBulkResponse {
  flags: (OfrepSuccess | OfrepFailure)[];
  /** [v4.6] `configVersion` — version của snapshot đã dùng (test I26 so theo nó) */
  metadata?: OfrepMetadata;
}

/** 400 của bulk: không có `key` */
export interface OfrepBulkFailure {
  errorCode: OfrepEvaluationErrorCode;
  errorDetails?: string;
}

// ------------------------------------------------------------- request

/**
 * Body OFREP: `{ context }`. Khoan dung với NỘI DUNG context như đánh giá local
 * (§6.4): `targetingKey` vắng ⇒ người vô danh; giá trị kiểu lạ giữ nguyên và toán
 * tử trả false. Chỉ chặn KÍCH THƯỚC — trần của CPU mà một người lạ tiêu được.
 */
export const ofrepRequestSchema = z.object({
  context: z.record(z.unknown()),
});

/** Vi phạm trần của context, hoặc `undefined` */
export function ofrepContextIssue(
  context: Record<string, unknown>,
): string | undefined {
  const keys = Object.keys(context);
  if (keys.length > OFREP.maxContextKeys) {
    return `context có ${String(keys.length)} thuộc tính (tối đa ${String(OFREP.maxContextKeys)})`;
  }
  for (const key of keys) {
    const value = context[key];
    if (typeof value === "string" && value.length > OFREP.maxContextString) {
      return `thuộc tính "${key}" dài hơn ${String(OFREP.maxContextString)} ký tự`;
    }
  }
  return undefined;
}

/**
 * Context có trần — cùng trần với OFREP, cho mọi đường đánh giá từ xa (Flag
 * Evaluation Tester ở S1/S2). `targetingKey` tuỳ chọn: người thử được thử cả
 * người dùng vô danh.
 */
export const evaluationContextSchema = z
  .record(z.unknown())
  .superRefine((context, ctx) => {
    const issue = ofrepContextIssue(context);
    if (issue !== undefined) ctx.addIssue({ code: "custom", message: issue });
  });
