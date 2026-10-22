import type {
  Evaluation,
  OfrepFailure,
  OfrepFlagNotFound,
  OfrepSuccess,
} from "@udp/shared-types";

/**
 * `Evaluation` của lõi ⇄ dây OFREP (§6.2 [v4.6]) — MỘT cặp hàm thuần, để I26 so
 * được đường local với đường OFREP trên cùng một mặt phẳng.
 *
 * Ba chỗ dây OFREP khác lõi, đều có chủ đích:
 *   - DEFAULT ⇒ `STATIC`: enum reason của OFREP ĐÓNG và không có DEFAULT. Lõi
 *     không bao giờ phát STATIC, nên ánh xạ là song ánh và `fromOfrep` đảo được.
 *   - DISABLED không có `value` — `codeDefaultFlag` của OFREP: ứng dụng dùng
 *     default trong code, đúng nghĩa DISABLED của UDP.
 *   - `ruleId` và thông điệp lỗi chi tiết KHÔNG lên dây: trình duyệt không được
 *     biết gì về rule (I11). Lỗi chỉ còn mã, kèm một câu chung.
 */

const ERROR_DETAILS = "Không đánh giá được flag này";

/** Phần tử của bulk, hoặc 200/400 của endpoint đơn. Không dùng cho FLAG_NOT_FOUND */
export function toOfrep(
  key: string,
  evaluation: Evaluation,
): OfrepSuccess | OfrepFailure {
  switch (evaluation.reason) {
    case "TARGETING_MATCH":
    case "SPLIT":
    case "DEFAULT":
      return {
        key,
        reason: evaluation.reason === "DEFAULT" ? "STATIC" : evaluation.reason,
        value: evaluation.value,
        ...(evaluation.variant === undefined
          ? {}
          : { variant: evaluation.variant }),
      };
    case "DISABLED":
      return {
        key,
        reason: "DISABLED",
        ...(evaluation.archived === true
          ? { metadata: { archived: true } }
          : {}),
      };
    case "ERROR":
      return { key, errorCode: "GENERAL", errorDetails: ERROR_DETAILS };
  }
}

/** 404 của endpoint đơn */
export function ofrepFlagNotFound(key: string): OfrepFlagNotFound {
  return { key, errorCode: "FLAG_NOT_FOUND" };
}

/**
 * Chiều ngược — cho test I26 và provider (§6.8). Kết quả so được với `Evaluation`
 * của lõi trên các trường OFREP mang: reason, value, variant, errorCode, archived.
 */
export function fromOfrep(
  item: OfrepSuccess | OfrepFailure | OfrepFlagNotFound,
): Evaluation {
  if ("errorCode" in item) {
    return {
      reason: "ERROR",
      errorCode:
        item.errorCode === "FLAG_NOT_FOUND" ? "FLAG_NOT_FOUND" : "GENERAL",
    };
  }
  if (item.reason === "DISABLED") {
    return item.metadata?.["archived"] === true
      ? { reason: "DISABLED", archived: true }
      : { reason: "DISABLED" };
  }
  const reason =
    item.reason === "STATIC"
      ? "DEFAULT"
      : item.reason === "TARGETING_MATCH" || item.reason === "SPLIT"
        ? item.reason
        : undefined;
  if (reason === undefined) return { reason: "ERROR", errorCode: "GENERAL" };
  return {
    reason,
    value: item.value,
    ...(item.variant === undefined ? {} : { variant: item.variant }),
  };
}

/**
 * Chiếu `Evaluation` xuống đúng các trường OFREP mang — mặt phẳng so sánh của I26.
 * `ruleId`, `errorMessage` không lên dây; mọi lỗi khác FLAG_NOT_FOUND thành GENERAL.
 */
export function ofrepVisible(evaluation: Evaluation): Evaluation {
  return fromOfrep(
    evaluation.reason === "ERROR" && evaluation.errorCode === "FLAG_NOT_FOUND"
      ? ofrepFlagNotFound("")
      : toOfrep("", evaluation),
  );
}
